#!/usr/bin/env tsx

/**
 * Unified LEGO Build Pipeline
 * 
 * Uses connection-based part placement with validation tools for reliable builds.
 * 
 * Phases:
 *   1. Generate broad blueprint (identify sub-assemblies)
 *   2. Build sub-assemblies in parallel using validate→preview→refine workflow
 *   3. Final assembly: connect sub-assemblies with validation
 *   4. Generate instruction book
 * 
 * Usage:
 *   npx tsx scripts/run-pipeline.ts --image path/to/image.png [--full]
 * 
 * Flags:
 *   --full    Run all sub-assemblies + final assembly
 *             Default: debug mode (1 sub-assembly, no final assembly)
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
import { readDb } from "@/lib/storage";
import type { InventoryItem } from "@/lib/models";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });

// ============================================================================
// CONSTANTS
// ============================================================================

const HALF_STUD = 10;     // LDU per half-stud
const PLATE_HEIGHT = 8;   // LDU per plate height

const ROTATION_MATRICES: Record<number, string> = {
  0:   "1 0 0 0 1 0 0 0 1",
  90:  "0 0 1 0 1 0 -1 0 0",
  180: "-1 0 0 0 1 0 0 0 -1",
  270: "0 0 -1 0 1 0 1 0 0",
};

// ============================================================================
// TYPES
// ============================================================================

interface ConnectedPart {
  part_id: string;
  color: number;
  attach_to: number | null;
  offset_x: number;
  offset_z: number;
  stack: "on_top" | "below";
  rotation: 0 | 90 | 180 | 270;
}

interface ResolvedPart {
  part_id: string;
  color: number;
  x: number;
  y: number;
  z: number;
  rotation: 0 | 90 | 180 | 270;
}

interface SubassemblyResult {
  name: string;
  description: string;
  parts: ConnectedPart[];
  ldraw: string;
  pieceCount: number;
  validationRounds: number;
}

interface PipelineResult {
  blueprint: Blueprint;
  subassemblies: SubassemblyResult[];
  finalAssembly: {
    ldraw: string;
    pieceCount: number;
    validationRounds: number;
    similarityScore?: number;
  } | null;
  instructionsPdfPath?: string;
}

interface Blueprint {
  overview: string;
  subassemblies: Array<{
    name: string;
    description: string;
    imageRegion: string;
    estimatedPieces: number;
  }>;
  totalEstimatedPieces: number;
}

// ============================================================================
// PART DATA
// ============================================================================

const PART_HEIGHTS: Record<string, number> = {
  "3001": 3, "3002": 3, "3003": 3, "3004": 3, "3005": 3,
  "3010": 3, "3009": 3, "3008": 3, "3007": 3, "3006": 3,
  "3020": 1, "3021": 1, "3022": 1, "3023": 1, "3024": 1,
  "3710": 1, "3666": 1, "3460": 1, "3031": 1, "3032": 1,
  "3033": 1, "3034": 1, "3035": 1, "3036": 1, "3030": 1, "3028": 1,
};

const PART_STUDS: Record<string, Array<[number, number]>> = {
  "3005": [[0, 0]],
  "3024": [[0, 0]],
  "3003": [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  "3022": [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  "3004": [[-1, 0], [1, 0]],
  "3023": [[-1, 0], [1, 0]],
  "3010": [[-3, 0], [-1, 0], [1, 0], [3, 0]],
  "3710": [[-3, 0], [-1, 0], [1, 0], [3, 0]],
  "3009": [[-5, 0], [-3, 0], [-1, 0], [1, 0], [3, 0], [5, 0]],
  "3666": [[-5, 0], [-3, 0], [-1, 0], [1, 0], [3, 0], [5, 0]],
  "3008": [[-7, 0], [-5, 0], [-3, 0], [-1, 0], [1, 0], [3, 0], [5, 0], [7, 0]],
  "3460": [[-7, 0], [-5, 0], [-3, 0], [-1, 0], [1, 0], [3, 0], [5, 0], [7, 0]],
  "3002": [[-2, -1], [0, -1], [2, -1], [-2, 1], [0, 1], [2, 1]],
  "3021": [[-2, -1], [0, -1], [2, -1], [-2, 1], [0, 1], [2, 1]],
  "3001": [[-3, -1], [-1, -1], [1, -1], [3, -1], [-3, 1], [-1, 1], [1, 1], [3, 1]],
  "3020": [[-3, -1], [-1, -1], [1, -1], [3, -1], [-3, 1], [-1, 1], [1, 1], [3, 1]],
  "3031": [
    [-3, -3], [-1, -3], [1, -3], [3, -3],
    [-3, -1], [-1, -1], [1, -1], [3, -1],
    [-3, 1], [-1, 1], [1, 1], [3, 1],
    [-3, 3], [-1, 3], [1, 3], [3, 3]
  ],
};

function getPartHeight(partId: string): number {
  return PART_HEIGHTS[partId] || 3;
}

function getRotatedStuds(partId: string, rotation: 0 | 90 | 180 | 270): Array<[number, number]> {
  const studs = PART_STUDS[partId] || [[0, 0]];
  return studs.map(([x, z]) => {
    switch (rotation) {
      case 90: return [z, -x] as [number, number];
      case 180: return [-x, -z] as [number, number];
      case 270: return [-z, x] as [number, number];
      default: return [x, z] as [number, number];
    }
  });
}

// ============================================================================
// VALIDATION
// ============================================================================

function validatePlacement(
  parentPartId: string,
  parentRotation: 0 | 90 | 180 | 270,
  childPartId: string,
  childRotation: 0 | 90 | 180 | 270,
  offsetX: number,
  offsetZ: number
): { valid: boolean; error?: string; suggestion?: string } {
  const parentStuds = getRotatedStuds(parentPartId, parentRotation);
  const childStuds = getRotatedStuds(childPartId, childRotation);
  const childStudsAbsolute = childStuds.map(([cx, cz]) => [cx + offsetX, cz + offsetZ]);
  
  let sharedStuds = 0;
  for (const [cx, cz] of childStudsAbsolute) {
    for (const [px, pz] of parentStuds) {
      if (cx === px && cz === pz) {
        sharedStuds++;
        break;
      }
    }
  }
  
  if (sharedStuds === 0) {
    const validOffsets: Array<[number, number]> = [];
    for (const [px, pz] of parentStuds) {
      for (const [cx, cz] of childStuds) {
        const tryX = px - cx;
        const tryZ = pz - cz;
        const overlap = childStuds.some(([c2x, c2z]) => 
          parentStuds.some(([p2x, p2z]) => c2x + tryX === p2x && c2z + tryZ === p2z)
        );
        if (overlap && !validOffsets.some(([vx, vz]) => vx === tryX && vz === tryZ)) {
          validOffsets.push([tryX, tryZ]);
        }
      }
    }
    validOffsets.sort((a, b) => Math.abs(a[0]) + Math.abs(a[1]) - Math.abs(b[0]) - Math.abs(b[1]));
    const suggestions = validOffsets.slice(0, 5).map(([x, z]) => `(${x},${z})`).join(", ");
    
    return {
      valid: false,
      error: `No stud connection at (${offsetX},${offsetZ})`,
      suggestion: suggestions ? `Try: ${suggestions}` : undefined
    };
  }
  
  return { valid: true };
}

function validateBuild(parts: ConnectedPart[]): { 
  valid: boolean; 
  errors: string[];
  summary: string;
} {
  const errors: string[] = [];
  
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.attach_to === null || part.attach_to === undefined) continue;
    
    const parentIdx = part.attach_to;
    if (parentIdx < 0 || parentIdx >= i) {
      errors.push(`[${i}] Invalid attach_to: ${parentIdx}`);
      continue;
    }
    
    const parent = parts[parentIdx];
    const result = validatePlacement(
      parent.part_id, parent.rotation,
      part.part_id, part.rotation,
      part.offset_x, part.offset_z
    );
    
    if (!result.valid) {
      let msg = `[${i}] ${part.part_id} on ${parent.part_id}: ${result.error}`;
      if (result.suggestion) msg += ` → ${result.suggestion}`;
      errors.push(msg);
    }
  }
  
  if (errors.length === 0) {
    return { valid: true, errors: [], summary: "VALID" };
  }
  
  return {
    valid: false,
    errors,
    summary: `INVALID (${errors.length}):\n${errors.join("\n")}`
  };
}

// ============================================================================
// LDRAW CONVERSION
// ============================================================================

function resolveConnections(parts: ConnectedPart[]): ResolvedPart[] {
  const resolved: ResolvedPart[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    let x: number, y: number, z: number;

    if (part.attach_to === null || part.attach_to === undefined) {
      x = part.offset_x * HALF_STUD;
      z = part.offset_z * HALF_STUD;
      y = 0;
    } else {
      const parentIdx = part.attach_to;
      if (parentIdx < 0 || parentIdx >= resolved.length) {
        x = 0; y = 0; z = 0;
      } else {
        const parent = resolved[parentIdx];
        const parentPart = parts[parentIdx];
        const parentHeight = getPartHeight(parentPart.part_id) * PLATE_HEIGHT;

        x = parent.x + part.offset_x * HALF_STUD;
        z = parent.z + part.offset_z * HALF_STUD;

        const thisHeight = getPartHeight(part.part_id) * PLATE_HEIGHT;
        if (part.stack === "on_top") {
          y = parent.y - thisHeight;
        } else {
          y = parent.y + parentHeight;
        }
      }
    }

    resolved.push({ part_id: part.part_id, color: part.color, x, y, z, rotation: part.rotation });
  }

  return resolved;
}

function partsToLDraw(parts: ConnectedPart[], modelName: string = "model"): string {
  const resolved = resolveConnections(parts);
  const lines: string[] = [
    `0 FILE ${modelName}.ldr`,
    `0 ${modelName}`,
    "0 Author: Pipeline",
  ];

  for (const part of resolved) {
    const rotMatrix = ROTATION_MATRICES[part.rotation] || ROTATION_MATRICES[0];
    lines.push(`1 ${part.color} ${part.x} ${part.y} ${part.z} ${rotMatrix} ${part.part_id}.dat`);
  }

  lines.push("0 STEP");
  lines.push("0 NOFILE");
  return lines.join("\n");
}

// ============================================================================
// RENDERING
// ============================================================================

function getLDViewBin(): string | null {
  if (process.env.LDVIEW_BIN && fs.existsSync(process.env.LDVIEW_BIN)) {
    return process.env.LDVIEW_BIN;
  }
  const candidates = [
    "/Applications/LDView-4.5.app/Contents/MacOS/LDView",
    "/Applications/LDView.app/Contents/MacOS/LDView",
  ];
  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

function render(mpdPath: string, outPath: string): boolean {
  const ldviewBin = getLDViewBin();
  if (!ldviewBin) return false;

  const ldrawDir = process.env.LDRAW_DIR || process.env.LDRAWDIR || path.join(process.env.HOME || "", "ldraw");
  const args = [
    mpdPath,
    `-LDrawDir=${ldrawDir}`,
    `-SaveSnapshot=${outPath}`,
    "-SaveWidth=1024",
    "-SaveHeight=1024",
    "-DefaultLatLong=45,315",
    "-SaveActualSize=0",
    "-AutoCrop=0",
    "-ShowErrors=0",
  ];

  const result = spawnSync(ldviewBin, args, { encoding: "utf8", timeout: 15000 });
  return fs.existsSync(outPath);
}

// ============================================================================
// OPENAI API
// ============================================================================

function readFileAsDataUrl(filePath: string): string {
  const data = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
  return `data:${mimeType};base64,${data.toString("base64")}`;
}

function buildInventoryDescription(inventory: InventoryItem[]): string {
  const byPart: Record<string, { colors: Record<number, number>; name?: string }> = {};
  for (const item of inventory) {
    if (!byPart[item.partNum]) {
      byPart[item.partNum] = { colors: {}, name: item.name };
    }
    byPart[item.partNum].colors[item.colorId] = (byPart[item.partNum].colors[item.colorId] || 0) + item.quantity;
  }
  const lines: string[] = [];
  for (const [partNum, info] of Object.entries(byPart)) {
    const colorStrs = Object.entries(info.colors).map(([c, q]) => `color ${c}: ${q}`);
    lines.push(`  ${partNum} (${info.name || "unknown"}): ${colorStrs.join(", ")}`);
  }
  return lines.join("\n");
}

const PARTS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["part_id", "color", "attach_to", "offset_x", "offset_z", "stack", "rotation"],
    properties: {
      part_id: { type: "string" },
      color: { type: "integer" },
      attach_to: { type: ["integer", "null"] },
      offset_x: { type: "integer" },
      offset_z: { type: "integer" },
      stack: { type: "string", enum: ["on_top", "below"] },
      rotation: { type: "integer", enum: [0, 90, 180, 270] }
    }
  }
};

const BUILD_TOOLS = [
  {
    type: "function",
    name: "validate_build",
    description: `Check stud connections. Call BEFORE preview_build. Returns "VALID" or errors with fix suggestions.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["parts"],
      properties: { parts: PARTS_SCHEMA }
    }
  },
  {
    type: "function",
    name: "preview_build",
    description: `Render current build. Call AFTER validate_build passes. Returns image.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["parts"],
      properties: { parts: PARTS_SCHEMA }
    }
  },
  {
    type: "function",
    name: "finalize_build",
    description: `Submit final build. Ends the session.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["parts"],
      properties: { parts: PARTS_SCHEMA }
    }
  }
];

interface OpenAIResponse {
  output_text?: string;
  output?: Array<{
    type: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: Array<{ type: string; text?: string }>;
  }>;
}

async function callOpenAI(params: {
  messages: Array<{ role?: string; type?: string; content?: unknown; call_id?: string; output?: string }>;
  tools?: unknown[];
  jsonSchema?: { name: string; schema: unknown };
  maxTokens?: number;
}): Promise<OpenAIResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const model = process.env.OPENAI_MODEL || "gpt-4o";
  const maxTokens = params.maxTokens || 20000;

  const body: Record<string, unknown> = {
    model,
    input: params.messages,
    max_output_tokens: maxTokens
  };

  if (params.tools) {
    body.tools = params.tools;
  }

  if (params.jsonSchema) {
    body.text = {
      format: {
        type: "json_schema",
        name: params.jsonSchema.name,
        schema: params.jsonSchema.schema,
        strict: true
      }
    };
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${errorText}`);
  }

  return (await res.json()) as OpenAIResponse;
}

function extractText(response: OpenAIResponse): string {
  if (response.output_text) return response.output_text;
  return response.output
    ?.flatMap(o => o.content ?? [])
    .filter(c => c.type === "output_text" || c.type === "text")
    .map(c => c.text)
    .join("\n\n") || "";
}

function extractToolCalls(response: OpenAIResponse): Array<{ id: string; name: string; arguments: string }> {
  const calls: Array<{ id: string; name: string; arguments: string }> = [];
  for (const o of response.output || []) {
    if (o.type === "function_call" && o.name && o.arguments) {
      const callId = o.call_id || o.id || "";
      calls.push({ id: callId, name: o.name, arguments: o.arguments });
    }
  }
  return calls;
}

// ============================================================================
// PHASE 1: BLUEPRINT
// ============================================================================

async function generateBlueprint(params: {
  imagePath: string;
  inventory: InventoryItem[];
  logDir: string;
}): Promise<Blueprint> {
  console.log("\n── Phase 1: Generating Blueprint ──");

  const imageDataUrl = readFileAsDataUrl(params.imagePath);
  const inventoryDesc = buildInventoryDescription(params.inventory);

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["overview", "subassemblies", "total_estimated_pieces"],
    properties: {
      overview: { type: "string" },
      subassemblies: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "description", "image_region", "estimated_pieces"],
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            image_region: { type: "string" },
            estimated_pieces: { type: "integer" }
          }
        }
      },
      total_estimated_pieces: { type: "integer" }
    }
  };

  const response = await callOpenAI({
    messages: [
      {
        role: "system",
        content: `You are analyzing a reference image to plan a LEGO build.
Identify 2-5 major sub-assemblies (e.g., legs, torso, head, accessories).
For each, describe WHERE in the image it appears and estimate pieces needed.
Keep total between 25-200 pieces.

IMPORTANT - COUNT CORRECTLY:
- If there are TWO legs, name it "Legs" (plural) and describe "both left and right legs"
- If there are TWO arms, name it "Arms" (plural) and describe "both arms"
- If there are TWO wings, name it "Wings" (plural)
- Count wheels, eyes, antennae, etc. and use plural names when >1
- Each sub-assembly should build ALL instances (e.g., "Legs" builds BOTH legs together)`
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Analyze this image and create a build plan:" },
          { type: "input_image", image_url: imageDataUrl },
          { type: "input_text", text: `Available parts:\n${inventoryDesc}` }
        ]
      }
    ],
    jsonSchema: { name: "blueprint", schema }
  });

  const text = extractText(response);
  const parsed = JSON.parse(text);

  const blueprint: Blueprint = {
    overview: parsed.overview,
    subassemblies: parsed.subassemblies.map((sa: any) => ({
      name: sa.name,
      description: sa.description,
      imageRegion: sa.image_region,
      estimatedPieces: sa.estimated_pieces
    })),
    totalEstimatedPieces: parsed.total_estimated_pieces
  };

  console.log(`  Overview: ${blueprint.overview.slice(0, 60)}...`);
  console.log(`  Sub-assemblies: ${blueprint.subassemblies.length}`);
  blueprint.subassemblies.forEach((sa, i) => {
    console.log(`    ${i + 1}. ${sa.name} (~${sa.estimatedPieces} pieces)`);
  });

  fs.writeFileSync(
    path.join(params.logDir, "01_blueprint.json"),
    JSON.stringify(blueprint, null, 2),
    "utf8"
  );

  return blueprint;
}

// ============================================================================
// PHASE 2: BUILD SUB-ASSEMBLY
// ============================================================================

function getSubassemblyPrompt(subassembly: Blueprint["subassemblies"][0]): string {
  return `You are building the "${subassembly.name}" sub-assembly.

DESCRIPTION: ${subassembly.description}
IMAGE REGION: ${subassembly.imageRegion}
TARGET: ~${subassembly.estimatedPieces} pieces

## IMPORTANT: COUNT MATTERS

Build the CORRECT NUMBER of each element:
- "Legs" = TWO legs (left and right)
- "Arms" = TWO arms (left and right)
- "Wings" = TWO wings (left and right)
- "Eyes" = TWO eyes
- "Wheels" = typically FOUR wheels

Look at the reference image and count how many of each part is visible.
If the name is plural ("legs", "arms"), build ALL of them, not just one.

## CONNECTION SYSTEM

Each part attaches to an existing part:
- attach_to: Index of parent (null for first part only)
- offset_x/offset_z: Position in half-studs from parent center
- stack: "on_top" or "below"
- rotation: 0, 90, 180, or 270 degrees

## STUD RULES

Even-width parts (2x2, 2x4) have NO center stud - studs at odd positions (±1, ±3)
Odd-width parts (1x1, 1x2) have center - studs at even positions (0, ±2)

Common valid offsets:
- 1x1 on 2x2: (±1, ±1)
- 2x2 on 2x2: (0,0), (±2,0), (0,±2)
- 1x2 on 2x2: (0,0), (±2,0)

## WORKFLOW

1. Call validate_build to check connections
2. If errors: fix using suggestions, validate again
3. Once valid: call preview_build to see result
4. Compare to reference image region, refine if needed
5. Call finalize_build when done

## PARTS

Bricks: 3001=2x4, 3003=2x2, 3004=1x2, 3005=1x1
Plates: 3020=2x4, 3022=2x2, 3023=1x2, 3024=1x1, 3031=4x4`;
}

async function buildSubassembly(params: {
  subassembly: Blueprint["subassemblies"][0];
  imagePath: string;
  inventory: InventoryItem[];
  logDir: string;
  subassemblyIndex: number;
}): Promise<SubassemblyResult> {
  const safeName = params.subassembly.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const saDir = path.join(params.logDir, `02_subassembly_${params.subassemblyIndex}_${safeName}`);
  fs.mkdirSync(saDir, { recursive: true });

  console.log(`  Building: ${params.subassembly.name}`);

  const imageDataUrl = readFileAsDataUrl(params.imagePath);
  const inventoryDesc = buildInventoryDescription(params.inventory);

  const messages: Array<any> = [
    { role: "system", content: getSubassemblyPrompt(params.subassembly) },
    {
      role: "user",
      content: [
        { type: "input_text", text: "Build this sub-assembly to match the reference image:" },
        { type: "input_image", image_url: imageDataUrl },
        { type: "input_text", text: `Available parts:\n${inventoryDesc}` }
      ]
    }
  ];

  let finalParts: ConnectedPart[] = [];
  let validationRounds = 0;
  let toolCallCount = 0;
  const maxIterations = 50;

  for (let iter = 1; iter <= maxIterations; iter++) {
    const response = await callOpenAI({ messages, tools: BUILD_TOOLS });
    const toolCalls = extractToolCalls(response);

    if (toolCalls.length === 0) {
      // Add assistant response and continue
      for (const item of response.output || []) {
        messages.push(item);
      }
      continue;
    }

    // Add assistant output items first
    for (const item of response.output || []) {
      messages.push(item);
    }

    for (const call of toolCalls) {
      toolCallCount++;
      const callNum = toolCallCount.toString().padStart(3, "0");

      let args: { parts: ConnectedPart[] };
      try {
        args = JSON.parse(call.arguments);
      } catch {
        messages.push({ type: "function_call_output", call_id: call.id, output: "Invalid JSON" });
        continue;
      }

      const parts = args.parts || [];

      // Save the parts
      fs.writeFileSync(
        path.join(saDir, `call${callNum}_parts.json`),
        JSON.stringify(parts, null, 2),
        "utf8"
      );

      if (call.name === "validate_build") {
        validationRounds++;
        const validation = validateBuild(parts);
        
        fs.writeFileSync(
          path.join(saDir, `call${callNum}_validation.json`),
          JSON.stringify(validation, null, 2),
          "utf8"
        );

        messages.push({
          type: "function_call_output",
          call_id: call.id,
          output: validation.summary
        });

      } else if (call.name === "preview_build") {
        const ldraw = partsToLDraw(parts, safeName);
        const mpdPath = path.join(saDir, `call${callNum}.mpd`);
        const pngPath = path.join(saDir, `call${callNum}.png`);
        
        fs.writeFileSync(mpdPath, ldraw, "utf8");
        const rendered = render(mpdPath, pngPath);

        if (rendered) {
          const renderDataUrl = readFileAsDataUrl(pngPath);
          
          messages.push({
            type: "function_call_output",
            call_id: call.id,
            output: JSON.stringify({ success: true, parts: parts.length })
          });

          // Send image for review
          messages.push({
            role: "user",
            content: [
              { type: "input_text", text: `Preview of ${params.subassembly.name} (${parts.length} parts).
              
Compare to the ${params.subassembly.imageRegion.toUpperCase()} region of the reference.
Does it match the shape and structure? If not, fix it. If yes, call finalize_build.` },
              { type: "input_image", image_url: renderDataUrl }
            ]
          });
        } else {
          messages.push({
            type: "function_call_output",
            call_id: call.id,
            output: JSON.stringify({ success: false, error: "Render failed" })
          });
        }

      } else if (call.name === "finalize_build") {
        finalParts = parts;
        
        const ldraw = partsToLDraw(parts, safeName);
        const mpdPath = path.join(saDir, "final.mpd");
        const pngPath = path.join(saDir, "final.png");
        
        fs.writeFileSync(mpdPath, ldraw, "utf8");
        render(mpdPath, pngPath);
        
        console.log(`    ✓ ${parts.length} pieces, ${validationRounds} validation rounds`);
        
        return {
          name: params.subassembly.name,
          description: params.subassembly.description,
          parts: finalParts,
          ldraw,
          pieceCount: parts.length,
          validationRounds
        };
      }
    }
  }

  // If we hit max iterations, return what we have
  console.log(`    ⚠ Max iterations reached`);
  const ldraw = partsToLDraw(finalParts, safeName);
  return {
    name: params.subassembly.name,
    description: params.subassembly.description,
    parts: finalParts,
    ldraw,
    pieceCount: finalParts.length,
    validationRounds
  };
}

// ============================================================================
// PHASE 3: FINAL ASSEMBLY
// ============================================================================

async function assembleSubassemblies(params: {
  blueprint: Blueprint;
  subassemblies: SubassemblyResult[];
  imagePath: string;
  inventory: InventoryItem[];
  logDir: string;
}): Promise<{ ldraw: string; pieceCount: number; validationRounds: number; similarityScore?: number }> {
  console.log("\n── Phase 3: Final Assembly ──");

  const finalDir = path.join(params.logDir, "03_final_assembly");
  fs.mkdirSync(finalDir, { recursive: true });

  // Create connection instructions for how sub-assemblies connect
  const connectPrompt = `You are assembling the final LEGO model by connecting sub-assemblies.

OVERVIEW: ${params.blueprint.overview}

SUB-ASSEMBLIES AVAILABLE:
${params.subassemblies.map((sa, i) => `${i}. ${sa.name}: ${sa.pieceCount} pieces - ${sa.description}`).join("\n")}

TASK: Create the final assembly by positioning each sub-assembly relative to others.

Use the connection system:
- First sub-assembly has attach_to: null (base)
- Others attach to previous sub-assemblies by index
- Use offset_x/offset_z to position them correctly
- The "parts" you output are actually SUB-ASSEMBLIES, not individual pieces

For the "part_id", use the sub-assembly name (e.g., "torso", "legs").
The system will substitute the actual sub-assembly LDraw content.

Match the reference image's proportions and layout.`;

  const imageDataUrl = readFileAsDataUrl(params.imagePath);

  const messages: Array<any> = [
    { role: "system", content: connectPrompt },
    {
      role: "user",
      content: [
        { type: "input_text", text: "Connect the sub-assemblies to match this reference:" },
        { type: "input_image", image_url: imageDataUrl }
      ]
    }
  ];

  // For final assembly, we'll manually handle the positioning
  // Create a combined MPD with proper positioning
  
  const totalPieces = params.subassemblies.reduce((sum, sa) => sum + sa.pieceCount, 0);
  
  // Simple vertical stacking for now - GPT can refine via validation
  let yOffset = 0;
  const subMpds: string[] = [];
  const mainRefs: string[] = [];

  for (const sa of params.subassemblies) {
    const safeName = sa.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    
    // Add sub-assembly as a sub-file
    subMpds.push(`0 FILE ${safeName}.ldr`);
    subMpds.push(sa.ldraw.split("\n").filter(l => !l.startsWith("0 FILE") && !l.startsWith("0 NOFILE")).join("\n"));
    subMpds.push("0 NOFILE");
    
    // Reference in main file
    mainRefs.push(`1 16 0 ${yOffset} 0 1 0 0 0 1 0 0 0 1 ${safeName}.ldr`);
    
    // Calculate height for next sub-assembly
    const maxY = sa.parts.reduce((max, p) => {
      const height = getPartHeight(p.part_id) * PLATE_HEIGHT;
      return Math.max(max, height);
    }, 0);
    yOffset -= maxY + 8; // Add small gap
  }

  const finalMpd = [
    "0 FILE main.ldr",
    `0 ${params.blueprint.overview}`,
    "0 Author: Pipeline",
    ...mainRefs,
    "0 STEP",
    "0 NOFILE",
    "",
    ...subMpds
  ].join("\n");

  // Save and render
  const mpdPath = path.join(finalDir, "final.mpd");
  const pngPath = path.join(finalDir, "final.png");
  
  fs.writeFileSync(mpdPath, finalMpd, "utf8");
  render(mpdPath, pngPath);

  console.log(`  Total pieces: ${totalPieces}`);
  console.log(`  Sub-assemblies: ${params.subassemblies.length}`);

  // TODO: Run physics validation and image similarity here
  // For now, just return the assembled result

  return {
    ldraw: finalMpd,
    pieceCount: totalPieces,
    validationRounds: 1,
    similarityScore: undefined
  };
}

// ============================================================================
// PHASE 4: GENERATE INSTRUCTIONS
// ============================================================================

async function generateInstructions(params: {
  finalMpd: string;
  logDir: string;
}): Promise<string | undefined> {
  console.log("\n── Phase 4: Generating Instructions ──");

  try {
    const { generateInstructionsPdfFromMpd, writeIdeaMpdToDisk } = await import("@/lib/lpub3d");
    
    const baseName = `build_${Date.now()}`;
    const tempMpdPath = writeIdeaMpdToDisk({ baseName, ldrawMpd: params.finalMpd });
    
    console.log("  Generating PDF (this may take a minute)...");
    const pdf = generateInstructionsPdfFromMpd({ 
      mpdPath: tempMpdPath, 
      baseName, 
      timeoutMs: 120000 
    });
    
    // Copy to log directory
    const destPath = path.join(params.logDir, "instructions.pdf");
    fs.copyFileSync(pdf.outPath, destPath);
    
    console.log(`  ✓ Instructions: ${destPath}`);
    return destPath;
  } catch (error) {
    console.log(`  ⚠ Could not generate instructions: ${error instanceof Error ? error.message : "unknown"}`);
    return undefined;
  }
}

// ============================================================================
// MAIN PIPELINE
// ============================================================================

async function runPipeline(params: {
  imagePath: string;
  fullMode: boolean;
}): Promise<PipelineResult> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  const logDir = path.join(process.cwd(), "data", "pipeline-output", `run_${timestamp}`);
  fs.mkdirSync(logDir, { recursive: true });

  // Copy input image
  fs.copyFileSync(params.imagePath, path.join(logDir, "00_input.png"));

  // Load inventory
  const db = readDb();
  const inventory: InventoryItem[] = db.inventory || [];

  console.log("══════════════════════════════════════════════════");
  console.log("LEGO BUILD PIPELINE");
  console.log("══════════════════════════════════════════════════");
  console.log(`Mode: ${params.fullMode ? "Full" : "Debug (1 sub-assembly)"}`);
  console.log(`Inventory: ${inventory.length} part types`);
  console.log(`Output: ${logDir}`);

  // Phase 1: Blueprint
  const blueprint = await generateBlueprint({ imagePath: params.imagePath, inventory, logDir });

  // Phase 2: Build sub-assemblies
  console.log("\n── Phase 2: Building Sub-Assemblies ──");
  
  const subassembliesToBuild = params.fullMode 
    ? blueprint.subassemblies 
    : blueprint.subassemblies.slice(0, 1);

  if (!params.fullMode && blueprint.subassemblies.length > 1) {
    console.log(`  (Debug mode: building 1 of ${blueprint.subassemblies.length})`);
  }

  const subassemblyResults: SubassemblyResult[] = [];
  
  // Build in parallel
  const buildPromises = subassembliesToBuild.map((sa, i) => 
    buildSubassembly({
      subassembly: sa,
      imagePath: params.imagePath,
      inventory,
      logDir,
      subassemblyIndex: i
    })
  );

  const results = await Promise.all(buildPromises);
  subassemblyResults.push(...results);

  // Phase 3: Final assembly (skip in debug mode)
  let finalAssembly = null;
  if (params.fullMode && subassemblyResults.length > 1) {
    finalAssembly = await assembleSubassemblies({
      blueprint,
      subassemblies: subassemblyResults,
      imagePath: params.imagePath,
      inventory,
      logDir
    });
  } else if (!params.fullMode) {
    console.log("\n── Phase 3: Final Assembly (Skipped - Debug Mode) ──");
  }

  // Phase 4: Generate instructions (only in full mode with final assembly)
  let instructionsPdfPath: string | undefined;
  if (finalAssembly) {
    instructionsPdfPath = await generateInstructions({
      finalMpd: finalAssembly.ldraw,
      logDir
    });
  }

  // Summary
  const totalPieces = subassemblyResults.reduce((sum, sa) => sum + sa.pieceCount, 0);
  const totalValidation = subassemblyResults.reduce((sum, sa) => sum + sa.validationRounds, 0);

  console.log("\n══════════════════════════════════════════════════");
  console.log("COMPLETE");
  console.log("══════════════════════════════════════════════════");
  console.log(`Sub-assemblies: ${subassemblyResults.length}${!params.fullMode ? " (debug)" : ""}`);
  console.log(`Total pieces: ${totalPieces}`);
  console.log(`Validation rounds: ${totalValidation}`);
  console.log(`Output: ${logDir}`);

  if (!params.fullMode) {
    console.log(`\nTo run full pipeline: npx tsx scripts/run-pipeline.ts --image ${params.imagePath} --full`);
  }

  // Save summary
  fs.writeFileSync(
    path.join(logDir, "99_summary.json"),
    JSON.stringify({
      timestamp,
      mode: params.fullMode ? "full" : "debug",
      blueprint,
      subassemblies: subassemblyResults.map(sa => ({
        name: sa.name,
        pieces: sa.pieceCount,
        validationRounds: sa.validationRounds
      })),
      finalAssembly: finalAssembly ? {
        pieces: finalAssembly.pieceCount,
        validationRounds: finalAssembly.validationRounds,
        similarityScore: finalAssembly.similarityScore
      } : null,
      instructionsPdfPath
    }, null, 2),
    "utf8"
  );

  return {
    blueprint,
    subassemblies: subassemblyResults,
    finalAssembly,
    instructionsPdfPath
  };
}

// ============================================================================
// CLI
// ============================================================================

function parseArgs(): { imagePath: string; fullMode: boolean } {
  const args = process.argv.slice(2);
  const imageIndex = args.indexOf("--image");

  if (imageIndex === -1 || !args[imageIndex + 1]) {
    console.error("Usage: npx tsx scripts/run-pipeline.ts --image <path> [--full]");
    console.error("");
    console.error("Flags:");
    console.error("  --full    Run all sub-assemblies + final assembly");
    console.error("            Default: debug mode (1 sub-assembly only)");
    process.exit(1);
  }

  const imagePath = args[imageIndex + 1];
  if (!fs.existsSync(imagePath)) {
    console.error(`Error: Image not found: ${imagePath}`);
    process.exit(1);
  }

  const fullMode = args.includes("--full");

  return { imagePath, fullMode };
}

async function main() {
  const args = parseArgs();
  await runPipeline(args);
}

main().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
