#!/usr/bin/env tsx
/**
 * Complex structure tests - 25-100 piece builds to verify validation and rendering
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PLATE_HEIGHT = 8;
const HALF_STUD = 10;

const ROTATION_MATRICES: Record<number, string> = {
  0: "1 0 0 0 1 0 0 0 1",
  90: "0 0 1 0 1 0 -1 0 0",
  180: "-1 0 0 0 1 0 0 0 -1",
  270: "0 0 -1 0 1 0 1 0 0",
};

const PART_HEIGHTS: Record<string, number> = {
  "3001": 3, "3002": 3, "3003": 3, "3004": 3, "3005": 3,
  "3010": 3, "3009": 3, "3008": 3,
  "3020": 1, "3021": 1, "3022": 1, "3023": 1, "3024": 1,
  "3710": 1, "3666": 1, "3460": 1, "3031": 1, "3032": 1, "3795": 1,
};

const PART_STUDS: Record<string, Array<[number, number]>> = {
  "3005": [[0, 0]], "3024": [[0, 0]],
  "3003": [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  "3022": [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  "3004": [[-1, 0], [1, 0]], "3023": [[-1, 0], [1, 0]],
  "3010": [[-3, 0], [-1, 0], [1, 0], [3, 0]],
  "3710": [[-3, 0], [-1, 0], [1, 0], [3, 0]],
  "3001": [[-3, -1], [-1, -1], [1, -1], [3, -1], [-3, 1], [-1, 1], [1, 1], [3, 1]],
  "3020": [[-3, -1], [-1, -1], [1, -1], [3, -1], [-3, 1], [-1, 1], [1, 1], [3, 1]],
  "3031": [
    [-3, -3], [-1, -3], [1, -3], [3, -3],
    [-3, -1], [-1, -1], [1, -1], [3, -1],
    [-3, 1], [-1, 1], [1, 1], [3, 1],
    [-3, 3], [-1, 3], [1, 3], [3, 3]
  ],
  "3032": [
    [-3, -3], [-1, -3], [1, -3], [3, -3],
    [-3, -1], [-1, -1], [1, -1], [3, -1],
    [-3, 1], [-1, 1], [1, 1], [3, 1],
    [-3, 3], [-1, 3], [1, 3], [3, 3]
  ],
  "3795": [
    [-3, -1], [-1, -1], [1, -1], [3, -1],
    [-3, 1], [-1, 1], [1, 1], [3, 1]
  ],
};

interface ConnectedPart {
  part_id: string; color: number; attach_to: number | null;
  offset_x: number; offset_z: number; stack: "on_top" | "below"; rotation: 0 | 90 | 180 | 270;
}

interface ResolvedPart {
  part_id: string; color: number; x: number; y: number; z: number; rotation: 0 | 90 | 180 | 270;
}

function getPartHeight(partId: string): number { return PART_HEIGHTS[partId] || 3; }

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

function validatePlacement(parentId: string, parentRot: 0|90|180|270, childId: string, childRot: 0|90|180|270, offX: number, offZ: number) {
  const parentStuds = getRotatedStuds(parentId, parentRot);
  const childStuds = getRotatedStuds(childId, childRot);
  const childAbs = childStuds.map(([cx, cz]) => [cx + offX, cz + offZ]);
  let shared = 0;
  for (const [cx, cz] of childAbs) {
    for (const [px, pz] of parentStuds) {
      if (cx === px && cz === pz) { shared++; break; }
    }
  }
  if (shared === 0) {
    const validOffsets: Array<[number, number]> = [];
    for (const [px, pz] of parentStuds) {
      for (const [cx, cz] of childStuds) {
        const tryX = px - cx, tryZ = pz - cz;
        if (!validOffsets.some(([vx, vz]) => vx === tryX && vz === tryZ)) {
          validOffsets.push([tryX, tryZ]);
        }
      }
    }
    validOffsets.sort((a, b) => Math.abs(a[0]) + Math.abs(a[1]) - Math.abs(b[0]) - Math.abs(b[1]));
    return { valid: false, suggestion: validOffsets.slice(0, 3).map(([x,z]) => `(${x},${z})`).join(", ") };
  }
  return { valid: true };
}

function validateBuild(parts: ConnectedPart[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.attach_to === null) continue;
    if (part.attach_to < 0 || part.attach_to >= i) {
      errors.push(`[${i}] Invalid attach_to: ${part.attach_to}`);
      continue;
    }
    const parent = parts[part.attach_to];
    const result = validatePlacement(parent.part_id, parent.rotation, part.part_id, part.rotation, part.offset_x, part.offset_z);
    if (!result.valid) {
      errors.push(`[${i}] ${part.part_id} on ${parent.part_id} at (${part.offset_x},${part.offset_z}): invalid → try ${result.suggestion}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

function resolveConnections(parts: ConnectedPart[]): ResolvedPart[] {
  const resolved: ResolvedPart[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    let x: number, y: number, z: number;
    if (part.attach_to === null) {
      x = part.offset_x * HALF_STUD; z = part.offset_z * HALF_STUD; y = 0;
    } else {
      const parent = resolved[part.attach_to];
      const parentPart = parts[part.attach_to];
      const parentHeight = getPartHeight(parentPart.part_id) * PLATE_HEIGHT;
      const thisHeight = getPartHeight(part.part_id) * PLATE_HEIGHT;
      x = parent.x + part.offset_x * HALF_STUD;
      z = parent.z + part.offset_z * HALF_STUD;
      y = part.stack === "on_top" ? parent.y - thisHeight : parent.y + parentHeight;
    }
    resolved.push({ part_id: part.part_id, color: part.color, x, y, z, rotation: part.rotation });
  }
  return resolved;
}

function toLDraw(resolved: ResolvedPart[]): string {
  const lines = ["0 FILE model.ldr", "0 Complex test build"];
  for (const part of resolved) {
    const m = ROTATION_MATRICES[part.rotation] || ROTATION_MATRICES[0];
    lines.push(`1 ${part.color} ${part.x} ${part.y} ${part.z} ${m} ${part.part_id}.dat`);
  }
  lines.push("0 STEP", "0 NOFILE");
  return lines.join("\n");
}

function render(mpdPath: string, outputPath: string): boolean {
  const ldviewBin = "/Applications/LDView-4.5.app/Contents/MacOS/LDView";
  if (!fs.existsSync(ldviewBin)) return false;
  const ldrawDir = process.env.LDRAW_DIR || process.env.LDRAWDIR || path.join(process.env.HOME || "", "ldraw");
  spawnSync(ldviewBin, [mpdPath, `-LDrawDir=${ldrawDir}`, `-SaveSnapshot=${outputPath}`,
    "-SaveWidth=800", "-SaveHeight=800", "-DefaultLatLong=45,315", "-SaveActualSize=0", "-AutoCrop=0", "-ShowErrors=0"], { timeout: 30000 });
  return fs.existsSync(outputPath);
}

// ============================================================================
// COMPLEX TEST STRUCTURES
// ============================================================================

// Helper to create a tower of 2x2 bricks
function tower2x2(baseIdx: number | null, height: number, color: number, offsetX = 0, offsetZ = 0): ConnectedPart[] {
  const parts: ConnectedPart[] = [];
  for (let i = 0; i < height; i++) {
    parts.push({
      part_id: "3003", color,
      attach_to: baseIdx === null && i === 0 ? null : (baseIdx === null ? parts.length - 1 + 0 : (i === 0 ? baseIdx : parts.length - 1 + (baseIdx === null ? 0 : 1))),
      offset_x: i === 0 ? offsetX : 0, offset_z: i === 0 ? offsetZ : 0,
      stack: "on_top", rotation: 0
    });
  }
  // Fix attach_to for non-first parts
  for (let i = 1; i < parts.length; i++) {
    parts[i].attach_to = i - 1;
    parts[i].offset_x = 0;
    parts[i].offset_z = 0;
  }
  if (baseIdx !== null) {
    parts[0].attach_to = baseIdx;
  }
  return parts;
}

// 1. CASTLE WALL (INVALID) - has bad offsets to test validation
function buildCastleWallInvalid(): ConnectedPart[] {
  const parts: ConnectedPart[] = [];
  
  // Base: row of 2x4 bricks - offset 6 is INVALID (should be 4 for overlap)
  for (let i = 0; i < 4; i++) {
    parts.push({
      part_id: "3001", color: 7,
      attach_to: i === 0 ? null : i - 1,
      offset_x: i === 0 ? 0 : 6, offset_z: 0, // BAD: 6 doesn't hit studs
      stack: "on_top", rotation: 0
    });
  }
  
  // Second row 
  for (let i = 0; i < 4; i++) {
    parts.push({
      part_id: "3001", color: 7,
      attach_to: i,
      offset_x: i === 0 ? -2 : 6, offset_z: 0, // BAD
      stack: "on_top", rotation: 0
    });
  }
  
  // Third row
  for (let i = 0; i < 4; i++) {
    parts.push({
      part_id: "3001", color: 7,
      attach_to: 4 + i,
      offset_x: i === 0 ? 2 : 6, offset_z: 0, // BAD
      stack: "on_top", rotation: 0
    });
  }
  
  // Crenellations with bad offsets
  for (let i = 0; i < 4; i++) {
    parts.push({
      part_id: "3003", color: 7,
      attach_to: 8 + i,
      offset_x: i * 4, offset_z: 0, // BAD: even offsets on 2x4
      stack: "on_top", rotation: 0
    });
  }
  
  return parts;
}

// 1b. CASTLE WALL (VALID) - corrected version
function buildCastleWallValid(): ConnectedPart[] {
  const parts: ConnectedPart[] = [];
  
  // Base: row of 2x4 bricks (offset 4 = 2 studs overlap)
  for (let i = 0; i < 4; i++) {
    parts.push({
      part_id: "3001", color: 7,
      attach_to: i === 0 ? null : i - 1,
      offset_x: i === 0 ? 0 : 4, offset_z: 0,
      stack: "on_top", rotation: 0
    });
  }
  
  // Second row offset for brick pattern
  for (let i = 0; i < 4; i++) {
    parts.push({
      part_id: "3001", color: 7,
      attach_to: i,
      offset_x: i === 0 ? -2 : 4, offset_z: 0,
      stack: "on_top", rotation: 0
    });
  }
  
  // Third row
  for (let i = 0; i < 4; i++) {
    parts.push({
      part_id: "3001", color: 7,
      attach_to: 4 + i,
      offset_x: i === 0 ? 2 : 4, offset_z: 0,
      stack: "on_top", rotation: 0
    });
  }
  
  // Crenellations - 2x2 on 2x4 must be at (0,0) or offset by 2 studs (4 half-studs)
  for (let i = 0; i < 4; i++) {
    parts.push({
      part_id: "3003", color: 7,
      attach_to: 8 + i,
      offset_x: i % 2 === 0 ? 0 : 2, offset_z: 0, // Valid: 2x2 studs align with 2x4 studs
      stack: "on_top", rotation: 0
    });
  }
  
  return parts;
}

// 2. PYRAMID - ~35 parts
function buildPyramid(): ConnectedPart[] {
  const parts: ConnectedPart[] = [];
  
  // Layer 1: 4x4 of 2x2 plates (base)
  const layer1Positions = [
    [0, 0], [4, 0], [0, 4], [4, 4]
  ];
  for (let i = 0; i < layer1Positions.length; i++) {
    const [x, z] = layer1Positions[i];
    parts.push({
      part_id: "3022", color: 14, // yellow
      attach_to: i === 0 ? null : 0,
      offset_x: x, offset_z: z,
      stack: "on_top", rotation: 0
    });
  }
  
  // Layer 2: slightly inset
  const baseSize = parts.length;
  for (let i = 0; i < 4; i++) {
    parts.push({
      part_id: "3022", color: 14,
      attach_to: i,
      offset_x: i < 2 ? 1 : -1, offset_z: i % 2 === 0 ? 1 : -1,
      stack: "on_top", rotation: 0
    });
  }
  
  // Continue building up with 2x2 bricks, getting smaller
  for (let layer = 0; layer < 5; layer++) {
    const prevBase = parts.length - 4;
    for (let i = 0; i < 4 - layer; i++) {
      if (layer >= 3 && i > 0) break; // Taper to single top
      parts.push({
        part_id: "3003", color: 14,
        attach_to: prevBase + Math.min(i, 3),
        offset_x: 0, offset_z: 0,
        stack: "on_top", rotation: 0
      });
    }
  }
  
  // Top piece
  parts.push({
    part_id: "3005", color: 4, // red tip
    attach_to: parts.length - 1,
    offset_x: 1, offset_z: 1,
    stack: "on_top", rotation: 0
  });
  
  return parts;
}

// 3. SIMPLE HOUSE - ~50 parts
function buildHouse(): ConnectedPart[] {
  const parts: ConnectedPart[] = [];
  
  // Foundation: 4x4 plates
  parts.push({ part_id: "3031", color: 7, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 });
  parts.push({ part_id: "3031", color: 7, attach_to: 0, offset_x: 8, offset_z: 0, stack: "on_top", rotation: 0 });
  
  // Front wall (with door gap)
  for (let layer = 0; layer < 4; layer++) {
    // Left side of door
    parts.push({
      part_id: "3001", color: 4,
      attach_to: layer === 0 ? 0 : parts.length - 3,
      offset_x: layer === 0 ? -2 : 0, offset_z: layer === 0 ? -2 : 0,
      stack: "on_top", rotation: 90
    });
    // Right side of door
    parts.push({
      part_id: "3001", color: 4,
      attach_to: layer === 0 ? 1 : parts.length - 3,
      offset_x: layer === 0 ? 2 : 0, offset_z: layer === 0 ? -2 : 0,
      stack: "on_top", rotation: 90
    });
    // Above door (starting layer 2)
    if (layer >= 2) {
      parts.push({
        part_id: "3001", color: 4,
        attach_to: parts.length - 2,
        offset_x: -4, offset_z: 0,
        stack: "on_top", rotation: 90
      });
    }
  }
  
  // Back wall
  for (let layer = 0; layer < 4; layer++) {
    parts.push({
      part_id: "3001", color: 4,
      attach_to: layer === 0 ? 0 : parts.length - 2,
      offset_x: layer === 0 ? -2 : 0, offset_z: layer === 0 ? 2 : 0,
      stack: "on_top", rotation: 90
    });
    parts.push({
      part_id: "3001", color: 4,
      attach_to: layer === 0 ? 1 : parts.length - 2,
      offset_x: layer === 0 ? 2 : 0, offset_z: layer === 0 ? 2 : 0,
      stack: "on_top", rotation: 90
    });
  }
  
  // Side walls
  for (let layer = 0; layer < 4; layer++) {
    parts.push({
      part_id: "3001", color: 4,
      attach_to: layer === 0 ? 0 : parts.length - 2,
      offset_x: layer === 0 ? -4 : 0, offset_z: layer === 0 ? 0 : 0,
      stack: "on_top", rotation: 0
    });
    parts.push({
      part_id: "3001", color: 4,
      attach_to: layer === 0 ? 1 : parts.length - 2,
      offset_x: layer === 0 ? 4 : 0, offset_z: layer === 0 ? 0 : 0,
      stack: "on_top", rotation: 0
    });
  }
  
  // Simple roof using plates
  const roofBase = parts.length - 1;
  for (let i = 0; i < 3; i++) {
    parts.push({
      part_id: "3020", color: 1, // blue roof
      attach_to: roofBase,
      offset_x: -2 + i * 4, offset_z: 0,
      stack: "on_top", rotation: 0
    });
  }
  
  return parts;
}

// 4. TOWER WITH SPIRAL - ~60 parts
function buildSpiralTower(): ConnectedPart[] {
  const parts: ConnectedPart[] = [];
  
  // Base platform
  parts.push({ part_id: "3031", color: 7, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 });
  
  // Central column
  for (let i = 0; i < 8; i++) {
    parts.push({
      part_id: "3003", color: 71,
      attach_to: i === 0 ? 0 : parts.length - 1,
      offset_x: 0, offset_z: 0,
      stack: "on_top", rotation: 0
    });
  }
  
  // Spiral stairs around the tower
  const spiralOffsets = [
    [2, 0], [2, 2], [0, 2], [-2, 2], [-2, 0], [-2, -2], [0, -2], [2, -2]
  ];
  for (let i = 0; i < 8; i++) {
    const [ox, oz] = spiralOffsets[i];
    parts.push({
      part_id: "3022", color: 6, // brown steps
      attach_to: 1 + i, // attach to corresponding tower level
      offset_x: ox, offset_z: oz,
      stack: "on_top", rotation: 0
    });
  }
  
  // Top platform
  parts.push({
    part_id: "3031", color: 7,
    attach_to: 8, // top of column
    offset_x: 0, offset_z: 0,
    stack: "on_top", rotation: 0
  });
  
  // Corner pillars on top
  const corners = [[-3, -3], [3, -3], [-3, 3], [3, 3]];
  for (const [cx, cz] of corners) {
    parts.push({
      part_id: "3005", color: 71,
      attach_to: parts.length - (corners.indexOf([cx, cz]) === 0 ? 1 : 2),
      offset_x: cx, offset_z: cz,
      stack: "on_top", rotation: 0
    });
  }
  // Fix corner attachments
  const topPlatformIdx = parts.length - 5;
  for (let i = 0; i < 4; i++) {
    parts[parts.length - 4 + i].attach_to = topPlatformIdx;
  }
  
  // Flag pole
  for (let i = 0; i < 3; i++) {
    parts.push({
      part_id: "3005", color: 0,
      attach_to: parts.length - 1,
      offset_x: i === 0 ? 0 : 0, offset_z: 0,
      stack: "on_top", rotation: 0
    });
  }
  
  // Flag
  parts.push({
    part_id: "3023", color: 4,
    attach_to: parts.length - 1,
    offset_x: 1, offset_z: 0,
    stack: "on_top", rotation: 0
  });
  
  return parts;
}

// 5. BRIDGE - ~40 parts  
function buildBridge(): ConnectedPart[] {
  const parts: ConnectedPart[] = [];
  
  // Left pillar base
  parts.push({ part_id: "3001", color: 7, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 });
  parts.push({ part_id: "3001", color: 7, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 90 });
  for (let i = 0; i < 3; i++) {
    parts.push({ part_id: "3001", color: 7, attach_to: parts.length - 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: i % 2 === 0 ? 0 : 90 });
  }
  
  // Right pillar base (separate base part)
  const rightPillarStart = parts.length;
  parts.push({ part_id: "3001", color: 7, attach_to: null, offset_x: 20, offset_z: 0, stack: "on_top", rotation: 0 });
  parts.push({ part_id: "3001", color: 7, attach_to: rightPillarStart, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 90 });
  for (let i = 0; i < 3; i++) {
    parts.push({ part_id: "3001", color: 7, attach_to: parts.length - 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: i % 2 === 0 ? 0 : 90 });
  }
  
  // Bridge deck - spans between pillars
  const leftTop = 4; // top of left pillar
  for (let i = 0; i < 4; i++) {
    parts.push({
      part_id: "3001", color: 6,
      attach_to: i === 0 ? leftTop : parts.length - 1,
      offset_x: i === 0 ? 2 : 4, offset_z: 0,
      stack: "on_top", rotation: 0
    });
  }
  
  // Railings
  const deckStart = parts.length - 4;
  for (let i = 0; i < 4; i++) {
    // Left rail
    parts.push({
      part_id: "3005", color: 0,
      attach_to: deckStart + i,
      offset_x: 1, offset_z: -1,
      stack: "on_top", rotation: 0
    });
    // Right rail
    parts.push({
      part_id: "3005", color: 0,
      attach_to: deckStart + i,
      offset_x: 1, offset_z: 1,
      stack: "on_top", rotation: 0
    });
  }
  
  return parts;
}

// 6. LARGE STAIRCASE - ~80 parts
function buildGrandStaircase(): ConnectedPart[] {
  const parts: ConnectedPart[] = [];
  
  // Base platform
  parts.push({ part_id: "3031", color: 7, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 });
  parts.push({ part_id: "3031", color: 7, attach_to: 0, offset_x: 8, offset_z: 0, stack: "on_top", rotation: 0 });
  parts.push({ part_id: "3031", color: 7, attach_to: 0, offset_x: 0, offset_z: 8, stack: "on_top", rotation: 0 });
  parts.push({ part_id: "3031", color: 7, attach_to: 0, offset_x: 8, offset_z: 8, stack: "on_top", rotation: 0 });
  
  // Stair steps going up
  let lastStep = 0;
  for (let step = 0; step < 12; step++) {
    // Each step is a 2x4 plate
    parts.push({
      part_id: "3020", color: 71,
      attach_to: step === 0 ? 0 : lastStep,
      offset_x: step === 0 ? 0 : 0, offset_z: step === 0 ? -2 : 2,
      stack: "on_top", rotation: 0
    });
    lastStep = parts.length - 1;
  }
  
  // Top landing
  const landingBase = parts.length - 1;
  parts.push({ part_id: "3031", color: 7, attach_to: landingBase, offset_x: 0, offset_z: 2, stack: "on_top", rotation: 0 });
  
  // Railings along stairs (left side)
  for (let i = 0; i < 6; i++) {
    parts.push({
      part_id: "3005", color: 6,
      attach_to: 4 + i * 2,
      offset_x: -3, offset_z: 0,
      stack: "on_top", rotation: 0
    });
    // Second level of railing
    parts.push({
      part_id: "3005", color: 6,
      attach_to: parts.length - 1,
      offset_x: 0, offset_z: 0,
      stack: "on_top", rotation: 0
    });
  }
  
  // Railings (right side)
  for (let i = 0; i < 6; i++) {
    parts.push({
      part_id: "3005", color: 6,
      attach_to: 4 + i * 2,
      offset_x: 3, offset_z: 0,
      stack: "on_top", rotation: 0
    });
    parts.push({
      part_id: "3005", color: 6,
      attach_to: parts.length - 1,
      offset_x: 0, offset_z: 0,
      stack: "on_top", rotation: 0
    });
  }
  
  // Decorative columns at base
  const columnPositions = [[-5, -5], [5, -5], [-5, 5], [5, 5]];
  for (const [cx, cz] of columnPositions) {
    for (let h = 0; h < 4; h++) {
      parts.push({
        part_id: "3005", color: 15,
        attach_to: h === 0 ? 0 : parts.length - 1,
        offset_x: h === 0 ? cx : 0, offset_z: h === 0 ? cz : 0,
        stack: "on_top", rotation: 0
      });
    }
  }
  
  return parts;
}

// ============================================================================
// RUN TESTS
// ============================================================================

const testBuilds: Array<{ name: string; builder: () => ConnectedPart[]; expectValid: boolean }> = [
  // INVALID builds - should be caught by validation
  { name: "castle_wall_INVALID", builder: buildCastleWallInvalid, expectValid: false },
  { name: "pyramid_INVALID", builder: buildPyramid, expectValid: false },  // Has bad offsets
  { name: "house_INVALID", builder: buildHouse, expectValid: false },      // Has bad offsets  
  { name: "staircase_INVALID", builder: buildGrandStaircase, expectValid: false }, // Has bad offsets
  
  // VALID builds - should pass validation
  { name: "castle_wall_VALID", builder: buildCastleWallValid, expectValid: true },
  { name: "spiral_tower_VALID", builder: buildSpiralTower, expectValid: true },
  { name: "bridge_VALID", builder: buildBridge, expectValid: true },
];

const outDir = path.join(process.cwd(), "data", "test-complex");
fs.mkdirSync(outDir, { recursive: true });

console.log("\n" + "=".repeat(60));
console.log("COMPLEX STRUCTURE TESTS (25-100 parts)");
console.log("=".repeat(60) + "\n");

let totalParts = 0;
let validationCorrect = 0;
let validationWrong = 0;
let renderSuccess = 0;
let renderFail = 0;
const failures: string[] = [];

for (const { name, builder, expectValid } of testBuilds) {
  console.log(`\n── ${name} ──`);
  
  const parts = builder();
  console.log(`  Parts: ${parts.length}`);
  totalParts += parts.length;
  
  // Validate
  const validation = validateBuild(parts);
  const validationMatches = validation.valid === expectValid;
  
  if (validationMatches) {
    validationCorrect++;
    if (validation.valid) {
      console.log(`  Validation: ✓ VALID (expected)`);
    } else {
      console.log(`  Validation: ✓ INVALID as expected (${validation.errors.length} errors caught)`);
      for (const err of validation.errors.slice(0, 3)) {
        console.log(`    ${err}`);
      }
      if (validation.errors.length > 3) {
        console.log(`    ... and ${validation.errors.length - 3} more`);
      }
    }
  } else {
    validationWrong++;
    if (validation.valid) {
      console.log(`  Validation: ✗ VALID but expected INVALID!`);
      failures.push(`${name}: Expected INVALID but got VALID`);
    } else {
      console.log(`  Validation: ✗ INVALID but expected VALID!`);
      for (const err of validation.errors) {
        console.log(`    ${err}`);
      }
      failures.push(`${name}: Expected VALID but got INVALID`);
    }
  }
  
  // Save JSON
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(parts, null, 2), "utf8");
  
  // Render anyway to see result
  const resolved = resolveConnections(parts);
  const ldraw = toLDraw(resolved);
  const mpdPath = path.join(outDir, `${name}.mpd`);
  const pngPath = path.join(outDir, `${name}.png`);
  fs.writeFileSync(mpdPath, ldraw, "utf8");
  
  if (render(mpdPath, pngPath)) {
    console.log(`  Render: ✓ saved`);
    renderSuccess++;
  } else {
    console.log(`  Render: ✗ FAILED`);
    renderFail++;
  }
}

console.log("\n" + "=".repeat(60));
console.log("SUMMARY");
console.log("=".repeat(60));
console.log(`Total structures: ${testBuilds.length}`);
console.log(`Total parts: ${totalParts}`);
console.log(`Validation tests: ${validationCorrect} correct, ${validationWrong} wrong`);
console.log(`Rendering: ${renderSuccess} success, ${renderFail} failed`);

if (failures.length > 0) {
  console.log(`\n✗ FAILURES:`);
  for (const f of failures) {
    console.log(`  - ${f}`);
  }
  process.exit(1);
} else {
  console.log(`\n✓ All validation expectations matched!`);
}

console.log(`\nOutput: ${outDir}`);
