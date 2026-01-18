#!/usr/bin/env tsx

/**
 * EXPERIMENTAL: Grid-based LEGO build pipeline with tool-based rendering
 * 
 * This pipeline constrains GPT to output structured JSON with grid coordinates,
 * making it impossible to violate LEGO placement rules. The conversion to LDraw
 * happens offline, ensuring valid output.
 * 
 * KEY FEATURE: GPT can call `preview_build` tool at any time to see a render
 * of the current state. This allows GPT to check its work incrementally rather
 * than waiting until the end.
 * 
 * Flow:
 *   1. GPT builds incrementally, calling preview_build when it wants feedback
 *   2. Each preview: JSON → LDraw → Render → Image returned to GPT
 *   3. GPT calls finalize_build when satisfied
 * 
 * Render time: ~100ms per preview (LDView is fast)
 * 
 * Usage:
 *   npx tsx scripts/run-grid-pipeline.ts --image path/to/image.png
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
import { readDb } from "@/lib/storage";
import type { InventoryItem } from "@/lib/models";

// Load environment variables
dotenv.config({ path: path.join(process.cwd(), ".env.local") });

// ============================================================================
// GRID CONSTANTS (from LEGO/LDraw specification)
// ============================================================================

const HALF_STUD = 10;     // LDU per half-stud (base grid unit for X and Z)
const PLATE_HEIGHT = 8;   // LDU per plate height (Y)

// ============================================================================
// PIPELINE SETTINGS (tune these to experiment)
// ============================================================================

const MAX_PARTS_BETWEEN_RENDERS = 25;  // GPT should preview at least this often

// Using half-stud (10 LDU) as base unit ensures proper alignment for ALL parts:
// - Even-width parts (2x2, 4x4) have studs at odd multiples of 10 (±10, ±30...)
// - Odd-width parts (1x1, 1x3) have studs at even multiples of 10 (0, ±20...)
// - Half-stud grid accommodates both

// Valid rotation matrices (90° increments around Y axis)
const ROTATION_MATRICES: Record<number, string> = {
  0:   "1 0 0 0 1 0 0 0 1",      // No rotation
  90:  "0 0 1 0 1 0 -1 0 0",     // 90° clockwise
  180: "-1 0 0 0 1 0 0 0 -1",    // 180°
  270: "0 0 -1 0 1 0 1 0 0",     // 270° clockwise (= 90° counter-clockwise)
};

// ============================================================================
// TYPES
// ============================================================================

// Legacy absolute coordinate interface (kept for reference)
interface GridPartLegacy {
  part_id: string;
  color: number;
  grid_x: number;
  grid_z: number;
  layer: number;
  rotation: 0 | 90 | 180 | 270;
}

// New connection-based interface - parts reference their parent
interface ConnectedPart {
  part_id: string;    // e.g., "3001" (2x4 brick)
  color: number;      // LDraw color code
  attach_to: number | null;  // Index of parent part (null = base/ground)
  offset_x: number;   // Offset from parent center in STUDS (not half-studs)
  offset_z: number;   // Offset from parent center in STUDS
  stack: "on_top" | "below";  // Vertical relationship to parent
  rotation: 0 | 90 | 180 | 270;  // Rotation around Y axis
}

interface ConnectedBuild {
  parts: ConnectedPart[];
}

// Resolved position after computing from connection graph
interface ResolvedPart {
  part_id: string;
  color: number;
  x: number;      // Absolute X in LDU
  y: number;      // Absolute Y in LDU
  z: number;      // Absolute Z in LDU
  rotation: 0 | 90 | 180 | 270;
}

// Part height lookup (in plate units)
const PART_HEIGHTS: Record<string, number> = {
  // Bricks (3 plates tall)
  "3001": 3, "3002": 3, "3003": 3, "3004": 3, "3005": 3,
  "3010": 3, "3009": 3, "3008": 3, "3007": 3, "3006": 3,
  // Plates (1 plate tall)
  "3020": 1, "3021": 1, "3022": 1, "3023": 1, "3024": 1,
  "3710": 1, "3666": 1, "3460": 1, "3031": 1, "3032": 1, "3033": 1,
  "3034": 1, "3035": 1, "3036": 1, "3030": 1, "3028": 1,
};

function getPartHeight(partId: string): number {
  return PART_HEIGHTS[partId] || 3;  // Default to brick height if unknown
}

// ============================================================================
// STUD POSITION VALIDATION
// ============================================================================

// Stud positions relative to part center, in half-stud units
// For even-width parts (2x2, 4x4), studs are at ODD positions (±1, ±3)
// For odd-width parts (1x1, 1x3), center stud is at 0
const PART_STUDS: Record<string, Array<[number, number]>> = {
  // 1x1 parts - single center stud
  "3005": [[0, 0]], // 1x1 brick
  "3024": [[0, 0]], // 1x1 plate
  // 2x2 parts - 4 studs at corners (NO center stud!)
  "3003": [[-1, -1], [1, -1], [-1, 1], [1, 1]], // 2x2 brick
  "3022": [[-1, -1], [1, -1], [-1, 1], [1, 1]], // 2x2 plate
  // 1x2 parts - 2 studs along length (X axis)
  "3004": [[-1, 0], [1, 0]], // 1x2 brick
  "3023": [[-1, 0], [1, 0]], // 1x2 plate
  // 1x4 parts - 4 studs along length
  "3010": [[-3, 0], [-1, 0], [1, 0], [3, 0]], // 1x4 brick
  "3710": [[-3, 0], [-1, 0], [1, 0], [3, 0]], // 1x4 plate
  // 1x6 parts
  "3009": [[-5, 0], [-3, 0], [-1, 0], [1, 0], [3, 0], [5, 0]], // 1x6 brick
  "3666": [[-5, 0], [-3, 0], [-1, 0], [1, 0], [3, 0], [5, 0]], // 1x6 plate
  // 1x8 parts
  "3008": [[-7, 0], [-5, 0], [-3, 0], [-1, 0], [1, 0], [3, 0], [5, 0], [7, 0]], // 1x8 brick
  "3460": [[-7, 0], [-5, 0], [-3, 0], [-1, 0], [1, 0], [3, 0], [5, 0], [7, 0]], // 1x8 plate
  // 2x3 parts
  "3002": [[-2, -1], [0, -1], [2, -1], [-2, 1], [0, 1], [2, 1]], // 2x3 brick
  "3021": [[-2, -1], [0, -1], [2, -1], [-2, 1], [0, 1], [2, 1]], // 2x3 plate
  // 2x4 parts - 8 studs in 2x4 grid
  "3001": [[-3, -1], [-1, -1], [1, -1], [3, -1], [-3, 1], [-1, 1], [1, 1], [3, 1]], // 2x4 brick
  "3020": [[-3, -1], [-1, -1], [1, -1], [3, -1], [-3, 1], [-1, 1], [1, 1], [3, 1]], // 2x4 plate
  // 4x4 plate - 16 studs
  "3031": [
    [-3, -3], [-1, -3], [1, -3], [3, -3],
    [-3, -1], [-1, -1], [1, -1], [3, -1],
    [-3, 1], [-1, 1], [1, 1], [3, 1],
    [-3, 3], [-1, 3], [1, 3], [3, 3]
  ],
};

// Get studs for a part, applying rotation
function getRotatedStuds(partId: string, rotation: 0 | 90 | 180 | 270): Array<[number, number]> {
  const studs = PART_STUDS[partId] || [[0, 0]]; // Default to single center stud
  return studs.map(([x, z]) => {
    switch (rotation) {
      case 90: return [z, -x] as [number, number];
      case 180: return [-x, -z] as [number, number];
      case 270: return [-z, x] as [number, number];
      default: return [x, z] as [number, number];
    }
  });
}

// Check if child part has valid stud connection to parent
function validatePlacement(
  parentPartId: string,
  parentRotation: 0 | 90 | 180 | 270,
  childPartId: string,
  childRotation: 0 | 90 | 180 | 270,
  offsetX: number,
  offsetZ: number
): { valid: boolean; sharedStuds: number; error?: string; suggestion?: string } {
  const parentStuds = getRotatedStuds(parentPartId, parentRotation);
  const childStuds = getRotatedStuds(childPartId, childRotation);
  
  // Child studs in parent's coordinate system
  const childStudsAbsolute = childStuds.map(([cx, cz]) => [cx + offsetX, cz + offsetZ]);
  
  // Count how many child studs land on parent studs
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
    // Generate suggestions for valid offsets
    const validOffsets: Array<[number, number]> = [];
    // Try offsets that would make at least one stud overlap
    for (const [px, pz] of parentStuds) {
      for (const [cx, cz] of childStuds) {
        const tryX = px - cx;
        const tryZ = pz - cz;
        // Check if this offset gives at least one overlap
        const overlap = childStuds.some(([c2x, c2z]) => 
          parentStuds.some(([p2x, p2z]) => c2x + tryX === p2x && c2z + tryZ === p2z)
        );
        if (overlap && !validOffsets.some(([vx, vz]) => vx === tryX && vz === tryZ)) {
          validOffsets.push([tryX, tryZ]);
        }
      }
    }
    
    // Pick a few good suggestions (sorted by distance from origin)
    validOffsets.sort((a, b) => Math.abs(a[0]) + Math.abs(a[1]) - Math.abs(b[0]) - Math.abs(b[1]));
    const suggestions = validOffsets.slice(0, 5).map(([x, z]) => `(${x},${z})`).join(", ");
    
    return {
      valid: false,
      sharedStuds: 0,
      error: `No stud connection: offset (${offsetX},${offsetZ}) doesn't align any ${childPartId} studs with ${parentPartId} studs`,
      suggestion: suggestions ? `Try one of these offsets: ${suggestions}` : undefined
    };
  }
  
  return { valid: true, sharedStuds };
}

// Validate entire build - returns errors for all invalid connections
function validateBuild(parts: ConnectedPart[]): { 
  valid: boolean; 
  errors: Array<{ partIndex: number; error: string; suggestion?: string }>;
  summary: string;
} {
  const errors: Array<{ partIndex: number; error: string; suggestion?: string }> = [];
  
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    
    // Skip base parts (attach_to is null)
    if (part.attach_to === null || part.attach_to === undefined) {
      continue;
    }
    
    const parentIdx = part.attach_to;
    
    // Check valid parent index
    if (parentIdx < 0 || parentIdx >= i) {
      errors.push({
        partIndex: i,
        error: `Invalid attach_to: ${parentIdx} (must be 0-${i - 1})`,
      });
      continue;
    }
    
    const parent = parts[parentIdx];
    const result = validatePlacement(
      parent.part_id,
      parent.rotation,
      part.part_id,
      part.rotation,
      part.offset_x,
      part.offset_z
    );
    
    if (!result.valid) {
      errors.push({
        partIndex: i,
        error: result.error || "Invalid placement",
        suggestion: result.suggestion
      });
    }
  }
  
  // Token-efficient output: just "VALID" or only the errors
  if (errors.length === 0) {
    return {
      valid: true,
      errors: [],
      summary: "VALID"
    };
  }
  
  // Only return errors, compact format
  const errorLines = errors.map(e => {
    const part = parts[e.partIndex];
    let line = `[${e.partIndex}] ${part.part_id} on ${parts[part.attach_to!].part_id}: ${e.error}`;
    if (e.suggestion) {
      line += ` → ${e.suggestion}`;
    }
    return line;
  });
  
  return {
    valid: false,
    errors,
    summary: `INVALID (${errors.length}):\n${errorLines.join("\n")}`
  };
}

interface BuildAttempt {
  round: number;
  gridBuild: ConnectedBuild;
  ldrawMpd: string;
  renderPath: string | null;
  renderError?: string;
}

// ============================================================================
// GRID → LDRAW CONVERSION
// ============================================================================

// Resolve connection-based build to absolute coordinates
function resolveConnections(build: ConnectedBuild): ResolvedPart[] {
  const resolved: ResolvedPart[] = [];

  for (let i = 0; i < build.parts.length; i++) {
    const part = build.parts[i];
    let x: number, y: number, z: number;

    if (part.attach_to === null || part.attach_to === undefined) {
      // Base part - place at origin, ground level (Y=0)
      x = part.offset_x * HALF_STUD;
      z = part.offset_z * HALF_STUD;
      y = 0;
    } else {
      // Connected part - compute position relative to parent
      const parentIdx = part.attach_to;
      if (parentIdx < 0 || parentIdx >= resolved.length) {
        console.warn(`Part ${i}: Invalid attach_to index ${parentIdx}, placing at origin`);
        x = 0;
        y = 0;
        z = 0;
      } else {
        const parent = resolved[parentIdx];
        const parentPart = build.parts[parentIdx];
        const parentHeight = getPartHeight(parentPart.part_id) * PLATE_HEIGHT;

        // Start from parent position (offsets in half-studs = 10 LDU each)
        x = parent.x + part.offset_x * HALF_STUD;
        z = parent.z + part.offset_z * HALF_STUD;

        // Stack vertically (LDraw Y+ is DOWN, so "on_top" means more negative Y)
        // In LDraw, Y coordinate is the TOP of the part, parts extend downward
        const thisHeight = getPartHeight(part.part_id) * PLATE_HEIGHT;
        
        if (part.stack === "on_top") {
          // This part sits on parent's top surface
          // This part's bottom = parent's top → thisY + thisHeight = parentY
          y = parent.y - thisHeight;
        } else {
          // "below" - this part goes under the parent
          // This part's top = parent's bottom → thisY = parentY + parentHeight
          y = parent.y + parentHeight;
        }
      }
    }

    resolved.push({
      part_id: part.part_id,
      color: part.color,
      x,
      y,
      z,
      rotation: part.rotation
    });
  }

  return resolved;
}

function connectedBuildToLDraw(build: ConnectedBuild): string {
  const resolved = resolveConnections(build);
  
  const lines: string[] = [
    "0 FILE model.ldr",
    "0 Connection-based LEGO build",
    "0 Author: GridPipeline",
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
// RENDERING (using LDView for speed - ~500ms vs 5-15s for LPub3D)
// ============================================================================

function getLDViewBin(): string | null {
  // Check environment variable first
  if (process.env.LDVIEW_BIN && fs.existsSync(process.env.LDVIEW_BIN)) {
    return process.env.LDVIEW_BIN;
  }
  
  // Check common locations (prefer 4.5 - 4.6 has macOS snapshot bug)
  const candidates = [
    "/Applications/LDView-4.5.app/Contents/MacOS/LDView",
    "/Applications/LDView.app/Contents/MacOS/LDView",
  ];
  
  for (const bin of candidates) {
    if (fs.existsSync(bin)) {
      return bin;
    }
  }
  
  return null;
}

function renderMpd(mpdPath: string, outputDir: string): { imagePath: string | null; error?: string; durationMs?: number } {
  const ldviewBin = getLDViewBin();
  
  if (!ldviewBin) {
    return { imagePath: null, error: "LDView not found. Install from: https://github.com/tcobbs/ldview/releases/tag/v4.5" };
  }

  const baseName = path.basename(mpdPath, ".mpd");
  const outPath = path.join(outputDir, `${baseName}.png`);
  const ldrawDir = process.env.LDRAW_DIR || process.env.LDRAWDIR || path.join(process.env.HOME || "", "ldraw");

  const startTime = Date.now();
  
  // LDView command line for snapshot
  const args = [
    mpdPath,
    `-LDrawDir=${ldrawDir}`,
    `-SaveSnapshot=${outPath}`,
    "-SaveWidth=1024",
    "-SaveHeight=1024",
    "-DefaultLatLong=45,315",  // Nice 3/4 view angle
    "-SaveActualSize=0",
    "-AutoCrop=0",
    "-ShowErrors=0",
  ];

  try {
    const result = spawnSync(ldviewBin, args, {
      encoding: "utf8",
      timeout: 15000,  // 15 second timeout (LDView is usually <1s)
    });

    const durationMs = Date.now() - startTime;

    if (result.error) {
      return { imagePath: null, error: `LDView error: ${result.error.message}`, durationMs };
    }

    if (!fs.existsSync(outPath)) {
      // Check stderr for clues
      const stderr = result.stderr || "";
      if (stderr.includes("Could not") || stderr.includes("not found")) {
        return { imagePath: null, error: `LDView failed: ${stderr.slice(0, 200)}`, durationMs };
      }
      return { imagePath: null, error: "LDView ran but PNG not created", durationMs };
    }

    return { imagePath: outPath, durationMs };
  } catch (e) {
    const durationMs = Date.now() - startTime;
    return { imagePath: null, error: `LDView exception: ${e instanceof Error ? e.message : String(e)}`, durationMs };
  }
}

// ============================================================================
// OPENAI INTEGRATION
// ============================================================================

function readFileAsDataUrl(filePath: string): string {
  const data = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
  return `data:${mimeType};base64,${data.toString("base64")}`;
}

function buildInventoryDescription(inventory: InventoryItem[]): string {
  // Group by part for compact display
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

// Schema for connection-based parts array
const PARTS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["part_id", "color", "attach_to", "offset_x", "offset_z", "stack", "rotation"],
    properties: {
      part_id: { 
        type: "string", 
        description: "LDraw part number without .dat extension (e.g., '3001' for 2x4 brick)" 
      },
      color: { 
        type: "integer", 
        description: "LDraw color code (e.g., 4=red, 14=yellow, 15=white, 0=black, 71=gray)" 
      },
      attach_to: { 
        type: ["integer", "null"],
        description: "Index of the part this connects to (0-based). Use null for the FIRST part only (base)." 
      },
      offset_x: { 
        type: "integer", 
        description: "Offset from parent's center in HALF-STUDS (10 LDU each). 0=centered, 2=one full stud right, -2=one full stud left. Use odd numbers for even-width parts." 
      },
      offset_z: { 
        type: "integer", 
        description: "Offset from parent's center in HALF-STUDS (10 LDU each). 0=centered, 2=one full stud forward, -2=one full stud back. Use odd numbers for even-width parts." 
      },
      stack: { 
        type: "string",
        enum: ["on_top", "below"],
        description: "Vertical relationship: 'on_top' places this part above the parent, 'below' places it underneath." 
      },
      rotation: { 
        type: "integer", 
        enum: [0, 90, 180, 270],
        description: "Rotation around vertical axis in degrees" 
      }
    }
  }
};

// Tool definitions for OpenAI function calling
const TOOLS = [
  {
    type: "function",
    name: "validate_build",
    description: `Check if all part placements have valid stud connections.
REQUIRED: Call this BEFORE preview_build to catch invalid placements early.
This is instant (no rendering) - validates that every part connects properly to its parent.
Returns either "ALL VALID" or a list of invalid parts with suggested fixes.
Workflow: design parts → validate_build → fix any errors → validate_build → preview_build`,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["parts"],
      properties: {
        parts: PARTS_SCHEMA
      }
    }
  },
  {
    type: "function",
    name: "preview_build",
    description: `Render the build to see how it looks visually.
Call this AFTER validate_build confirms all connections are valid.
Returns a rendered image to check shape, proportions, and colors.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["parts"],
      properties: {
        parts: PARTS_SCHEMA
      }
    }
  },
  {
    type: "function",
    name: "finalize_build",
    description: `Submit your final build. Call this when you're satisfied with the result.
This ends the build session and saves the final model.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["parts"],
      properties: {
        parts: PARTS_SCHEMA
      }
    }
  }
];

// Legacy schema for non-tool mode
const GRID_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["parts"],
  properties: {
    parts: PARTS_SCHEMA
  }
} as const;

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface OpenAIResponse {
  id?: string;
  status?: string;
  output_text?: string;
  output?: Array<{
    type: string;
    id?: string;
    name?: string;
    arguments?: string;
    content?: Array<{ type: string; text?: string }>;
  }>;
}

function extractTextFromResponse(json: OpenAIResponse): string {
  return (
    (typeof json.output_text === "string" && json.output_text.trim().length > 0
      ? json.output_text
      : json.output
          ?.flatMap((o) => o.content ?? [])
          .filter((c) => c.type === "output_text" || c.type === "text")
          .map((c) => c.text)
          .join("\n\n")) || ""
  );
}

function extractToolCalls(json: OpenAIResponse): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const o of json.output || []) {
    if (o.type === "function_call" && o.name && o.arguments) {
      // Use call_id for responding to function calls (not the item id)
      const callId = (o as { call_id?: string }).call_id || o.id;
      if (callId) {
        calls.push({ id: callId, name: o.name, arguments: o.arguments });
      }
    }
  }
  return calls;
}

// Get timeout from env or use generous default (15 minutes)
function getTimeoutMs(): number {
  const envTimeout = process.env.OPENAI_TIMEOUT_MS;
  if (envTimeout) {
    const parsed = parseInt(envTimeout, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 900_000; // 15 minutes default
}

// Tool-based API call - GPT can call preview_build or finalize_build
async function callOpenAIWithTools(params: {
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  maxTokens: number;
}): Promise<{ toolCalls: ToolCall[]; text: string; raw: OpenAIResponse }> {
  const body = {
    model: params.model,
    input: params.messages,
    tools: TOOLS,
    max_output_tokens: params.maxTokens
  };

  const timeoutMs = getTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${errorText}`);
    }

    const json = (await res.json()) as OpenAIResponse;
    const toolCalls = extractToolCalls(json);
    const text = extractTextFromResponse(json);

    return { toolCalls, text, raw: json };
  } finally {
    clearTimeout(timeout);
  }
}

// Legacy non-tool mode (kept for backwards compatibility)
async function callOpenAIWithGridSchema(params: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
  maxTokens: number;
}): Promise<{ build: ConnectedBuild | null; rawResponse: string }> {
  // Convert userContent to the format expected by the responses API
  const inputContent: Array<{ type: string; text?: string; image_url?: string }> = [];
  for (const item of params.userContent) {
    if (item.type === "text") {
      inputContent.push({ type: "input_text", text: item.text });
    } else if (item.type === "image_url") {
      inputContent.push({ type: "input_image", image_url: item.image_url.url });
    }
  }

  const body = {
    model: params.model,
    input: [
      { role: "system", content: params.systemPrompt },
      { role: "user", content: inputContent }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "lego_grid_build",
        schema: GRID_SCHEMA,
        strict: true
      }
    },
    max_output_tokens: params.maxTokens
  };

  const timeoutMs = getTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${errorText}`);
    }

    const json = (await res.json()) as OpenAIResponse;
    const text = extractTextFromResponse(json);

    try {
      const parsed = JSON.parse(text) as ConnectedBuild;
      return { build: parsed, rawResponse: text };
    } catch {
      return { build: null, rawResponse: text };
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================================
// MAIN PIPELINE
// ============================================================================

function getSystemPrompt(): string {
  return `You are an expert LEGO builder. You design builds using a GRID-BASED coordinate system.

## COORDINATE SYSTEM

- **grid_x / grid_z**: Position in HALF-STUD UNITS (10 LDU each). 0 = center.
  - One full stud spacing = 2 units (e.g., grid_x=0 and grid_x=2 are one stud apart)
  - This allows precise alignment for all part sizes
- **layer**: Vertical position in PLATE HEIGHTS (8 LDU each). 0 = ground level.
  - Bricks are 3 plates tall → stack at layers 0, 3, 6, 9...
  - Plates are 1 plate tall → stack at layers 0, 1, 2, 3...
- **rotation**: 0, 90, 180, or 270 degrees around the vertical axis.

## STACKING RULES

Parts connect when their studs/tubes align:
- BRICK on BRICK: add 3 to layer
- PLATE on BRICK: add 3 to layer
- BRICK on PLATE: add 1 to layer
- PLATE on PLATE: add 1 to layer

## COMMON PARTS

Bricks (3 plates tall):
- 3001 = 2x4 brick
- 3002 = 2x3 brick
- 3003 = 2x2 brick
- 3004 = 1x2 brick
- 3005 = 1x1 brick
- 3010 = 1x4 brick
- 3009 = 1x6 brick
- 3008 = 1x8 brick

Plates (1 plate tall):
- 3020 = 2x4 plate
- 3021 = 2x3 plate
- 3022 = 2x2 plate
- 3023 = 1x2 plate
- 3024 = 1x1 plate
- 3710 = 1x4 plate
- 3666 = 1x6 plate
- 3031 = 4x4 plate

## COLORS (common LDraw codes)

0 = Black, 1 = Blue, 4 = Red, 14 = Yellow, 15 = White, 
7 = Light Gray, 8 = Dark Gray, 2 = Green, 10 = Bright Green,
6 = Brown, 70 = Reddish Brown, 71 = Light Bluish Gray, 72 = Dark Bluish Gray

## IMPORTANT

- Use ONLY parts from the provided inventory
- Match colors available in inventory
- Build something recognizable that matches the reference image
- Keep builds between 20-100 parts for best results
- Ensure ALL parts connect (no floating pieces)`;
}

function getReviewPrompt(attempt: BuildAttempt): string {
  return `## BUILD REVIEW - Round ${attempt.round}

You generated a build with ${attempt.gridBuild.parts.length} parts. Here is the rendered result.

CAREFULLY EXAMINE THE RENDER AND CHECK:

1. **SHAPE**: Does it match the reference image's overall shape/silhouette?
2. **PROPORTIONS**: Are the proportions correct (not too tall, wide, thin)?
3. **FEATURES**: Are the key recognizable features present?
4. **STRUCTURE**: Do all parts appear connected (no floating pieces)?
5. **COLORS**: Do the colors match what's expected?

If the build looks good and matches the reference, output the same build.
If there are problems, FIX THEM by modifying the parts array.

Common fixes:
- Floating parts: Adjust their layer to connect to parts below
- Wrong proportions: Add/remove parts or adjust positions
- Missing features: Add parts to create the missing elements
- Wrong colors: Change color codes to match reference`;
}

function getToolSystemPrompt(): string {
  return `You are an expert LEGO builder. You design builds using a CONNECTION-BASED system where each part attaches to an existing part.

## TOOLS (use in this order)

1. **validate_build** - Check stud connections are valid (instant, text-only)
2. **preview_build** - Render to see visual appearance (fast, ~100ms)
3. **finalize_build** - Submit final build (ends session)

## REQUIRED WORKFLOW

ALWAYS follow this pattern:
1. Design several parts (5-15 at a time)
2. Call **validate_build** to check all connections
3. If invalid: fix the errors using the suggestions provided, then validate again
4. Once valid: call **preview_build** to see the visual result
5. If looks wrong: fix and repeat from step 2
6. When satisfied: call **finalize_build**

**CRITICAL**: Never call preview_build without first calling validate_build. Validation catches structural errors (parts between studs) before wasting a render.

## STUD CONNECTION RULES

Parts connect via STUDS. Your offset MUST align child studs with parent studs.

**EVEN-width parts (2x2, 4x4, 2x4) have NO center stud!**
- 2x2 studs at: (±1, ±1) - corners only
- 4x4 studs at: (±1, ±1), (±1, ±3), (±3, ±1), (±3, ±3) - all odd positions
- 2x4 studs at: (±1, ±1), (±3, ±1) - two rows

**ODD-width parts (1x1, 1x2, 1x4) have a center line:**
- 1x1 stud at: (0, 0)
- 1x2 studs at: (±1, 0)
- 1x4 studs at: (±1, 0), (±3, 0)

**Common mistakes the validator catches:**
- 1x1 on 2x2 at (0,0) → INVALID (2x2 has no center stud). Use (±1, ±1)
- 2x2 on 1x1 at (0,0) → INVALID (2x2 corners miss the 1x1). Use (1,1) or (-1,-1)
- 1x2 rotated 90° at wrong offset → INVALID. Rotation changes stud positions!

## CONNECTION SYSTEM

- **attach_to**: Index of parent part (0-based). Use \`null\` ONLY for first part.
- **offset_x / offset_z**: Offset in HALF-STUDS from parent center.
- **stack**: "on_top" = above parent, "below" = underneath.
- **rotation**: 0, 90, 180, or 270 degrees (changes stud positions!).

## QUICK REFERENCE: Valid Offsets

| Child | Parent | Valid Offsets |
|-------|--------|---------------|
| 1x1 | 2x2 | (±1, ±1) |
| 1x1 | 2x4 | (±1, ±1), (±3, ±1) |
| 2x2 | 2x2 | (0,0), (±2,0), (0,±2), (±2,±2) |
| 2x2 | 4x4 | (0,0), (±2,0), (0,±2), (±2,±2) |
| 2x2 | 1x1 | (±1, ±1) - corner on the 1x1 |
| 1x2 | 2x2 | (0,0), (±2,0), (0,±2) |
| 1x2 rot90 | 2x2 | (±1, 0) |

## COMMON PARTS

Bricks: 3001=2x4, 3003=2x2, 3004=1x2, 3005=1x1, 3010=1x4
Plates: 3020=2x4, 3022=2x2, 3023=1x2, 3024=1x1, 3710=1x4, 3031=4x4

## COLORS

0=Black, 1=Blue, 4=Red, 14=Yellow, 15=White, 7=Light Gray, 2=Green, 6=Brown`;
}

// ============================================================================
// TOOL-BASED PIPELINE (GPT controls when to preview)
// ============================================================================

interface ToolCallLog {
  iteration: number;
  timestamp: string;
  tool_name: string;
  tool_call_id: string;
  gpt_request: {
    parts_count: number;
    parts: ConnectedPart[];
    raw_arguments: string;
  };
  our_response: {
    ldraw_file?: string;
    render_path?: string;
    render_duration_ms?: number;
    error?: string;
  };
}

async function runToolBasedPipeline(params: {
  imagePath: string;
  inventory: InventoryItem[];
  logDir: string;
  maxIterations?: number;
}): Promise<void> {
  // Allow up to 250 tool calls as stated in the prompt
  const { imagePath, inventory, logDir, maxIterations = 250 } = params;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  
  const model = process.env.OPENAI_MODEL || "gpt-4o";
  // Use generous token limit - we're not optimizing for cost at this phase
  const maxTokens = parseInt(process.env.OPENAI_MAX_OUTPUT_TOKENS || "50000", 10);

  const refImageDataUrl = readFileAsDataUrl(imagePath);
  const inventoryDesc = buildInventoryDescription(inventory);

  const timeoutMin = Math.round(getTimeoutMs() / 60000);
  
  console.log("\n══════════════════════════════════════════════════");
  console.log("GRID-BASED LEGO PIPELINE (Tool Mode)");
  console.log("══════════════════════════════════════════════════");
  console.log(`Reference: ${imagePath}`);
  console.log(`Inventory: ${inventory.length} part types`);
  console.log(`Model: ${model}`);
  console.log(`Max tokens: ${maxTokens}`);
  console.log(`Max iterations: ${maxIterations}`);
  console.log(`API timeout: ${timeoutMin} minutes`);
  console.log(`Output: ${logDir}`);
  console.log("");

  // Create logs subdirectory
  const logsDir = path.join(logDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  // Track all tool calls for comprehensive logging
  const allToolCallLogs: ToolCallLog[] = [];
  const apiCallLogs: Array<{
    iteration: number;
    timestamp: string;
    duration_ms: number;
    request_messages_count: number;
    response_tool_calls: number;
    response_text_length: number;
  }> = [];

  // Build conversation history
  const systemPrompt = getToolSystemPrompt();
  const messages: Array<{ role: string; content: unknown }> = [
    { role: "system", content: systemPrompt },
    { 
      role: "user", 
      content: [
        { type: "input_text", text: "## REFERENCE IMAGE\nBuild something that looks like this:" },
        { type: "input_image", image_url: refImageDataUrl },
        { type: "input_text", text: `## AVAILABLE INVENTORY\n${inventoryDesc}` },
        { type: "input_text", text: "## TASK\nCreate a LEGO build that resembles the reference image. Call finalize_build when done." }
      ]
    }
  ];

  // Save initial prompt
  fs.writeFileSync(
    path.join(logsDir, "00_system_prompt.txt"),
    systemPrompt,
    "utf8"
  );
  fs.writeFileSync(
    path.join(logsDir, "00_inventory.txt"),
    inventoryDesc,
    "utf8"
  );

  let toolCallCounter = 0;
  let finalBuild: ConnectedBuild | null = null;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const iterTimestamp = new Date().toISOString();
    console.log(`\n── Iteration ${iteration} ──`);
    console.log("  Calling OpenAI...");
    const startTime = Date.now();

    const { toolCalls, text, raw } = await callOpenAIWithTools({
      apiKey,
      model,
      messages,
      maxTokens
    });

    const elapsed = Date.now() - startTime;
    console.log(`  Response received (${(elapsed / 1000).toFixed(1)}s)`);

    // Log API call
    const apiLog = {
      iteration,
      timestamp: iterTimestamp,
      duration_ms: elapsed,
      request_messages_count: messages.length,
      response_tool_calls: toolCalls.length,
      response_text_length: text.length
    };
    apiCallLogs.push(apiLog);

    // Save raw API response
    fs.writeFileSync(
      path.join(logsDir, `iter${iteration.toString().padStart(3, "0")}_api_response.json`),
      JSON.stringify({ 
        iteration,
        timestamp: iterTimestamp,
        duration_ms: elapsed,
        tool_calls: toolCalls,
        text: text,
        raw_response: raw
      }, null, 2),
      "utf8"
    );

    if (toolCalls.length === 0) {
      console.log("  No tool calls - GPT returned text only");
      if (text) {
        console.log(`  Text: ${text.slice(0, 200)}...`);
        fs.writeFileSync(
          path.join(logsDir, `iter${iteration.toString().padStart(3, "0")}_text_response.txt`),
          text,
          "utf8"
        );
      }
      // Add as assistant message and continue
      messages.push({ role: "assistant", content: text });
      continue;
    }

    // IMPORTANT: Add the assistant's output items (including function_call) to messages
    // This is required by the OpenAI responses API before we can send function_call_output
    for (const item of raw.output || []) {
      messages.push(item as { role: string; content: unknown });
    }

    // Process each tool call
    for (const call of toolCalls) {
      toolCallCounter++;
      const callNum = toolCallCounter.toString().padStart(3, "0");
      console.log(`  Tool: ${call.name} (call #${toolCallCounter})`);

      // Initialize log entry
      const toolLog: ToolCallLog = {
        iteration,
        timestamp: new Date().toISOString(),
        tool_name: call.name,
        tool_call_id: call.id,
        gpt_request: {
          parts_count: 0,
          parts: [],
          raw_arguments: call.arguments
        },
        our_response: {}
      };

      // Save GPT's raw request
      fs.writeFileSync(
        path.join(logsDir, `call${callNum}_gpt_request.json`),
        JSON.stringify({
          tool_name: call.name,
          tool_call_id: call.id,
          arguments: call.arguments,
          parsed: null // Will be updated below
        }, null, 2),
        "utf8"
      );

      let args: { parts: ConnectedPart[] };
      try {
        args = JSON.parse(call.arguments);
        toolLog.gpt_request.parts = args.parts || [];
        toolLog.gpt_request.parts_count = toolLog.gpt_request.parts.length;
        
        // Update the saved file with parsed data
        fs.writeFileSync(
          path.join(logsDir, `call${callNum}_gpt_request.json`),
          JSON.stringify({
            tool_name: call.name,
            tool_call_id: call.id,
            arguments_raw: call.arguments,
            arguments_parsed: args,
            parts_count: args.parts?.length || 0
          }, null, 2),
          "utf8"
        );
      } catch {
        console.log("    ERROR: Invalid JSON arguments");
        toolLog.our_response.error = "Invalid JSON in arguments";
        allToolCallLogs.push(toolLog);
        
        // Use function_call_output format for responses API
        messages.push({
          type: "function_call_output",
          call_id: call.id,
          output: JSON.stringify({ error: "Invalid JSON in arguments" })
        } as { role: string; content: unknown });
        continue;
      }

      const build: ConnectedBuild = { parts: args.parts || [] };
      console.log(`    Parts: ${build.parts.length}`);

      // Save the connection-based JSON
      fs.writeFileSync(
        path.join(logsDir, `call${callNum}_connections.json`),
        JSON.stringify(build, null, 2),
        "utf8"
      );

      // Handle validate_build tool - fast text-only validation
      if (call.name === "validate_build") {
        const validation = validateBuild(build.parts);
        
        console.log(`    Validation: ${validation.valid ? "✓ ALL VALID" : `✗ ${validation.errors.length} errors`}`);
        
        // Log validation result
        fs.writeFileSync(
          path.join(logsDir, `call${callNum}_validation.json`),
          JSON.stringify({
            valid: validation.valid,
            errors: validation.errors,
            summary: validation.summary
          }, null, 2),
          "utf8"
        );
        
        toolLog.our_response = { 
          validation_result: validation.valid ? "valid" : "invalid",
          error_count: validation.errors.length
        } as typeof toolLog.our_response;
        allToolCallLogs.push(toolLog);
        
        // Return validation result to GPT
        messages.push({
          type: "function_call_output",
          call_id: call.id,
          output: validation.summary
        });
        
        continue;
      }

      if (call.name === "preview_build" || call.name === "finalize_build") {
        // Convert connections to LDraw (resolves absolute positions)
        const ldrawMpd = connectedBuildToLDraw(build);
        const mpdPath = path.join(logsDir, `call${callNum}_model.mpd`);
        fs.writeFileSync(mpdPath, ldrawMpd, "utf8");
        toolLog.our_response.ldraw_file = `call${callNum}_model.mpd`;

        // Render
        const renderStartTime = Date.now();
        const { imagePath: renderPath, error: renderError, durationMs } = renderMpd(mpdPath, logsDir);
        const actualRenderDuration = durationMs || (Date.now() - renderStartTime);

        if (renderPath) {
          const finalRenderName = `call${callNum}_render.png`;
          const finalRenderPath = path.join(logsDir, finalRenderName);
          fs.renameSync(renderPath, finalRenderPath);
          
          toolLog.our_response.render_path = finalRenderName;
          toolLog.our_response.render_duration_ms = actualRenderDuration;
          
          console.log(`    Render: ${finalRenderName} (${actualRenderDuration}ms)`);

          // Also copy to main logDir for easy viewing
          fs.copyFileSync(finalRenderPath, path.join(logDir, finalRenderName));

          if (call.name === "preview_build") {
            // Return tool output using function_call_output format (responses API)
            const renderDataUrl = readFileAsDataUrl(finalRenderPath);
            
            // Add function_call_output for the tool result
            messages.push({
              type: "function_call_output",
              call_id: call.id,
              output: JSON.stringify({ 
                success: true, 
                parts_count: build.parts.length, 
                render_time_ms: actualRenderDuration 
              })
            });
            
            // Add the rendered image as a user message so GPT can see it
            const reviewPrompt = `Here is the rendered preview of your build (${build.parts.length} parts).

EXAMINE YOUR CURRENT BUILD:

1. **SHAPE**: Does your build so far match the intended shape from the reference?
2. **PROPORTIONS**: Is what you've built so far the right size/scale for this section?
3. **COLORS**: Are the colors correct for this part of the build?

If something looks wrong, FIX IT before adding more parts - then preview again to confirm.
If it looks good, continue building.`;

            messages.push({
              role: "user",
              content: [
                { type: "input_text", text: reviewPrompt },
                { type: "input_image", image_url: renderDataUrl }
              ]
            });

            // Log what we sent back (without the base64 image data)
            fs.writeFileSync(
              path.join(logsDir, `call${callNum}_our_response.json`),
              JSON.stringify({
                type: "preview_success",
                parts_count: build.parts.length,
                render_duration_ms: actualRenderDuration,
                render_file: finalRenderName,
                message_sent: `Preview: ${build.parts.length} parts rendered in ${actualRenderDuration}ms.`
              }, null, 2),
              "utf8"
            );
          } else {
            // finalize_build
            finalBuild = build;
            
            // Also save to main directory
            fs.copyFileSync(path.join(logsDir, `call${callNum}_connections.json`), path.join(logDir, "final_connections.json"));
            fs.copyFileSync(mpdPath, path.join(logDir, "final_model.mpd"));
            fs.copyFileSync(finalRenderPath, path.join(logDir, "final_render.png"));

            fs.writeFileSync(
              path.join(logsDir, `call${callNum}_our_response.json`),
              JSON.stringify({
                type: "finalize_success",
                parts_count: build.parts.length,
                render_duration_ms: actualRenderDuration,
                render_file: finalRenderName,
                final: true
              }, null, 2),
              "utf8"
            );

            console.log("\n✓ Build finalized!");
          }
        } else {
          toolLog.our_response.error = renderError;
          console.log(`    Render failed: ${renderError}`);
          
          // Return error using function_call_output format
          messages.push({
            type: "function_call_output",
            call_id: call.id,
            output: JSON.stringify({ success: false, error: renderError, parts_count: build.parts.length })
          });

          fs.writeFileSync(
            path.join(logsDir, `call${callNum}_our_response.json`),
            JSON.stringify({
              type: "render_error",
              error: renderError,
              parts_count: build.parts.length
            }, null, 2),
            "utf8"
          );
        }
      }

      allToolCallLogs.push(toolLog);
    }

    if (finalBuild) break;
  }

  // Save comprehensive summary
  const summary = {
    mode: "tool-based",
    model,
    max_tokens: maxTokens,
    started_at: apiCallLogs[0]?.timestamp,
    finished_at: new Date().toISOString(),
    total_iterations: apiCallLogs.length,
    total_tool_calls: toolCallCounter,
    total_api_time_ms: apiCallLogs.reduce((sum, l) => sum + l.duration_ms, 0),
    final_part_count: finalBuild?.parts.length || 0,
    finalized: !!finalBuild,
    api_calls: apiCallLogs,
    tool_calls: allToolCallLogs
  };

  fs.writeFileSync(path.join(logDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");

  // Also save a simple timeline
  const timeline = allToolCallLogs.map((t, i) => 
    `${i + 1}. [${t.timestamp}] ${t.tool_name}: ${t.gpt_request.parts_count} parts` +
    (t.our_response.render_duration_ms ? ` → rendered in ${t.our_response.render_duration_ms}ms` : "") +
    (t.our_response.error ? ` → ERROR: ${t.our_response.error}` : "")
  ).join("\n");
  fs.writeFileSync(path.join(logDir, "timeline.txt"), timeline, "utf8");

  console.log("\n══════════════════════════════════════════════════");
  console.log("PIPELINE COMPLETE");
  console.log("══════════════════════════════════════════════════");
  console.log(`Total iterations: ${apiCallLogs.length}`);
  console.log(`Total tool calls: ${toolCallCounter}`);
  console.log(`Total API time: ${(summary.total_api_time_ms / 1000).toFixed(1)}s`);
  console.log(`Final parts: ${finalBuild?.parts.length || 0}`);
  console.log(`Output: ${logDir}`);
  console.log(`Logs: ${logsDir}`);
}

async function runGridPipeline(params: {
  imagePath: string;
  inventory: InventoryItem[];
  logDir: string;
  maxRounds?: number;
}): Promise<void> {
  const { imagePath, inventory, logDir, maxRounds = 10 } = params;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  
  const model = process.env.OPENAI_MODEL || "gpt-4o";
  // Use generous token limit - we're not optimizing for cost at this phase
  const maxTokens = parseInt(process.env.OPENAI_MAX_OUTPUT_TOKENS || "50000", 10);

  // Read reference image
  const refImageDataUrl = readFileAsDataUrl(imagePath);
  const inventoryDesc = buildInventoryDescription(inventory);

  console.log("\n══════════════════════════════════════════════════");
  console.log("GRID-BASED LEGO PIPELINE");
  console.log("══════════════════════════════════════════════════");
  console.log(`Reference: ${imagePath}`);
  console.log(`Inventory: ${inventory.length} part types`);
  console.log(`Max rounds: ${maxRounds}`);
  console.log(`Output: ${logDir}`);
  console.log("");

  const attempts: BuildAttempt[] = [];
  let currentBuild: ConnectedBuild | null = null;

  for (let round = 1; round <= maxRounds; round++) {
    console.log(`\n── Round ${round} ──`);

    // Build the prompt content
    const userContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];

    // Always include reference image
    userContent.push({ 
      type: "text", 
      text: "## REFERENCE IMAGE\nBuild something that looks like this:" 
    });
    userContent.push({ 
      type: "image_url", 
      image_url: { url: refImageDataUrl } 
    });

    // Include inventory
    userContent.push({
      type: "text",
      text: `## AVAILABLE INVENTORY\n${inventoryDesc}`
    });

    // If we have a previous attempt, include the render for review
    if (attempts.length > 0) {
      const lastAttempt = attempts[attempts.length - 1];
      
      if (lastAttempt.renderPath && fs.existsSync(lastAttempt.renderPath)) {
        const renderDataUrl = readFileAsDataUrl(lastAttempt.renderPath);
        
        userContent.push({
          type: "text",
          text: getReviewPrompt(lastAttempt)
        });
        userContent.push({
          type: "image_url",
          image_url: { url: renderDataUrl }
        });
      } else if (lastAttempt.renderError) {
        userContent.push({
          type: "text",
          text: `## RENDER FAILED\nError: ${lastAttempt.renderError}\n\nPlease fix any issues and try again. Common causes:\n- Invalid part IDs\n- Parts placed outside reasonable bounds\n- Complex geometry`
        });
      }
    } else {
      // First round - just ask for initial build
      userContent.push({
        type: "text",
        text: "## TASK\nCreate a LEGO build that resembles the reference image using the available inventory."
      });
    }

    // Call OpenAI
    console.log("  Calling OpenAI...");
    const startTime = Date.now();
    
    const { build, rawResponse } = await callOpenAIWithGridSchema({
      apiKey,
      model,
      systemPrompt: getSystemPrompt(),
      userContent,
      maxTokens
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  Response received (${elapsed}s)`);

    if (!build || !build.parts || build.parts.length === 0) {
      console.log("  ERROR: No valid build returned");
      fs.writeFileSync(
        path.join(logDir, `round${round}_error.json`),
        rawResponse,
        "utf8"
      );
      continue;
    }

    currentBuild = build;
    console.log(`  Parts: ${build.parts.length}`);

    // Save the grid JSON
    fs.writeFileSync(
      path.join(logDir, `round${round}_grid.json`),
      JSON.stringify(build, null, 2),
      "utf8"
    );

    // Convert connections to LDraw
    const ldrawMpd = connectedBuildToLDraw(build);
    const mpdPath = path.join(logDir, `round${round}_model.mpd`);
    fs.writeFileSync(mpdPath, ldrawMpd, "utf8");
    console.log(`  LDraw saved: ${mpdPath}`);

    // Render (LDView is fast - typically <1 second)
    console.log("  Rendering with LDView...");
    const { imagePath: renderPath, error: renderError, durationMs: renderDuration } = renderMpd(mpdPath, logDir);

    const attempt: BuildAttempt = {
      round,
      gridBuild: build,
      ldrawMpd,
      renderPath,
      renderError
    };
    attempts.push(attempt);

    if (renderPath) {
      // Rename to include round number
      const finalRenderPath = path.join(logDir, `round${round}_render.png`);
      if (renderPath !== finalRenderPath) {
        fs.renameSync(renderPath, finalRenderPath);
        attempt.renderPath = finalRenderPath;
      }
      const renderTime = renderDuration ? ` (${renderDuration}ms)` : "";
      console.log(`  Render saved: ${finalRenderPath}${renderTime}`);
    } else {
      const renderTime = renderDuration ? ` (${renderDuration}ms)` : "";
      console.log(`  Render failed: ${renderError}${renderTime}`);
    }

    // Check if build is unchanged from previous round (GPT is satisfied)
    if (attempts.length >= 2) {
      const prev = attempts[attempts.length - 2];
      const curr = attempts[attempts.length - 1];
      
      // Simple check: same number of parts and same JSON
      const prevJson = JSON.stringify(prev.gridBuild);
      const currJson = JSON.stringify(curr.gridBuild);
      
      if (prevJson === currJson) {
        console.log("\n✓ Build unchanged - GPT is satisfied!");
        break;
      }
    }
  }

  // Save final summary
  const summary = {
    totalRounds: attempts.length,
    finalPartCount: currentBuild?.parts.length || 0,
    attempts: attempts.map(a => ({
      round: a.round,
      parts: a.gridBuild.parts.length,
      renderSuccess: !!a.renderPath,
      renderError: a.renderError
    }))
  };

  fs.writeFileSync(
    path.join(logDir, "summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8"
  );

  console.log("\n══════════════════════════════════════════════════");
  console.log("PIPELINE COMPLETE");
  console.log("══════════════════════════════════════════════════");
  console.log(`Total rounds: ${attempts.length}`);
  console.log(`Final part count: ${currentBuild?.parts.length || 0}`);
  console.log(`Output: ${logDir}`);
}

// ============================================================================
// CLI
// ============================================================================

function parseArgs(): { imagePath: string; useTools: boolean } {
  const args = process.argv.slice(2);
  const imageIndex = args.indexOf("--image");

  if (imageIndex === -1 || !args[imageIndex + 1]) {
    console.error("Usage: npx tsx scripts/run-grid-pipeline.ts --image <path> [--tools]");
    console.error("");
    console.error("Flags:");
    console.error("  --tools   Use tool-based mode (GPT controls when to preview)");
    console.error("            Default: legacy mode (render after each round)");
    process.exit(1);
  }

  const imagePath = args[imageIndex + 1];
  if (!fs.existsSync(imagePath)) {
    console.error(`Error: Image not found: ${imagePath}`);
    process.exit(1);
  }

  const useTools = args.includes("--tools");

  return { imagePath, useTools };
}

async function main() {
  const args = parseArgs();

  // Setup logging directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  const mode = args.useTools ? "tools" : "legacy";
  const logDir = path.join(process.cwd(), "data", "grid-pipeline-output", `${mode}_${timestamp}`);
  fs.mkdirSync(logDir, { recursive: true });

  // Copy input image
  fs.copyFileSync(args.imagePath, path.join(logDir, "00_reference.png"));

  // Load inventory
  const db = readDb();
  const inventory: InventoryItem[] = db.inventory || [];

  if (inventory.length === 0) {
    console.error("Error: Inventory is empty!");
    process.exit(1);
  }

  if (args.useTools) {
    await runToolBasedPipeline({
      imagePath: args.imagePath,
      inventory,
      logDir
    });
  } else {
    await runGridPipeline({
      imagePath: args.imagePath,
      inventory,
      logDir
    });
  }
}

main().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
