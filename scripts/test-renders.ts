#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PLATE_HEIGHT = 8;
const HALF_STUD = 10;

/**
 * TODO: Add handling for standard "composite" bricks
 * 
 * Many LEGO parts have different footprints at different vertical levels.
 * Examples:
 * - Modified plates: 2x2 plate with 1x2 plate on top (part 99206)
 * - Brackets: 1x2 - 1x2 inverted bracket (part 99781)
 * - Modified bricks with studs on side (part 11211)
 * - Slope bricks where top surface is smaller than base
 * - Cheese slopes (1x1 with 2/3 height)
 * 
 * These require tracking:
 * 1. Base footprint (for "below" connections)
 * 2. Top footprint (for "on_top" connections) 
 * 3. Connection points that may be offset from center
 * 4. Side stud positions for sideways building
 * 
 * Proposed schema extension:
 * ```
 * PART_GEOMETRY: Record<string, {
 *   base_width: number;   // in studs
 *   base_depth: number;   // in studs
 *   top_width: number;    // in studs (may differ from base)
 *   top_depth: number;    // in studs (may differ from base)
 *   top_offset_x: number; // half-studs, offset of top surface from center
 *   top_offset_z: number; // half-studs, offset of top surface from center
 *   height: number;       // in plates
 *   side_studs?: Array<{x: number, y: number, z: number, direction: 'x+'|'x-'|'z+'|'z-'}>
 * }>
 * ```
 */

const ROTATION_MATRICES: Record<number, string> = {
  0: "1 0 0 0 1 0 0 0 1",
  90: "0 0 1 0 1 0 -1 0 0",
  180: "-1 0 0 0 1 0 0 0 -1",
  270: "0 0 -1 0 1 0 1 0 0",
};

const PART_HEIGHTS: Record<string, number> = {
  "3001": 3, "3002": 3, "3003": 3, "3004": 3, "3005": 3,
  "3010": 3, "3009": 3, "3008": 3, "3622": 3,
  "3020": 1, "3021": 1, "3022": 1, "3023": 1, "3024": 1,
  "3710": 1, "3666": 1, "3460": 1, "3031": 1, "3032": 1, "3795": 1,
};

interface ConnectedPart {
  part_id: string; color: number; attach_to: number | null;
  offset_x: number; offset_z: number; stack: "on_top" | "below"; rotation: 0 | 90 | 180 | 270;
}
interface ResolvedPart { part_id: string; color: number; x: number; y: number; z: number; rotation: 0 | 90 | 180 | 270; }

function getPartHeight(partId: string): number { return PART_HEIGHTS[partId] || 3; }

// Stud positions relative to part center, in half-stud units
// For a part centered at (0,0), these are the (x,z) positions of each stud
const PART_STUDS: Record<string, Array<[number, number]>> = {
  // 1x1 parts - single center stud
  "3005": [[0, 0]], // 1x1 brick
  "3024": [[0, 0]], // 1x1 plate
  // 2x2 parts - 4 studs at corners (no center stud!)
  "3003": [[-1, -1], [1, -1], [-1, 1], [1, 1]], // 2x2 brick
  "3022": [[-1, -1], [1, -1], [-1, 1], [1, 1]], // 2x2 plate
  // 1x2 parts - 2 studs along length (X axis by default)
  "3004": [[-1, 0], [1, 0]], // 1x2 brick
  "3023": [[-1, 0], [1, 0]], // 1x2 plate
  // 1x4 parts - 4 studs along length
  "3010": [[-3, 0], [-1, 0], [1, 0], [3, 0]], // 1x4 brick
  "3710": [[-3, 0], [-1, 0], [1, 0], [3, 0]], // 1x4 plate
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
function validateConnection(
  parentPartId: string,
  parentRotation: 0 | 90 | 180 | 270,
  childPartId: string, 
  childRotation: 0 | 90 | 180 | 270,
  offsetX: number,
  offsetZ: number
): { valid: boolean; sharedStuds: number; error?: string } {
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
    return {
      valid: false,
      sharedStuds: 0,
      error: `No stud overlap: child at offset (${offsetX},${offsetZ}) doesn't align with any parent studs`
    };
  }
  
  return { valid: true, sharedStuds };
}

// Validate entire build
function validateBuild(parts: ConnectedPart[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.attach_to === null || part.attach_to === undefined) continue;
    
    const parentIdx = part.attach_to;
    if (parentIdx < 0 || parentIdx >= i) {
      errors.push(`Part ${i}: Invalid attach_to index ${parentIdx}`);
      continue;
    }
    
    const parent = parts[parentIdx];
    const result = validateConnection(
      parent.part_id, parent.rotation,
      part.part_id, part.rotation,
      part.offset_x, part.offset_z
    );
    
    if (!result.valid) {
      errors.push(`Part ${i} (${part.part_id}) -> Part ${parentIdx} (${parent.part_id}): ${result.error}`);
    }
  }
  
  return { valid: errors.length === 0, errors };
}

function resolveConnections(parts: ConnectedPart[]): ResolvedPart[] {
  const resolved: ResolvedPart[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    let x: number, y: number, z: number;
    if (part.attach_to === null || part.attach_to === undefined) {
      x = part.offset_x * HALF_STUD; z = part.offset_z * HALF_STUD; y = 0;
    } else {
      const parentIdx = part.attach_to;
      if (parentIdx < 0 || parentIdx >= resolved.length) { x = 0; y = 0; z = 0; }
      else {
        const parent = resolved[parentIdx];
        const parentPart = parts[parentIdx];
        const parentHeight = getPartHeight(parentPart.part_id) * PLATE_HEIGHT;
        const thisHeight = getPartHeight(part.part_id) * PLATE_HEIGHT;
        x = parent.x + part.offset_x * HALF_STUD;
        z = parent.z + part.offset_z * HALF_STUD;
        if (part.stack === "on_top") { y = parent.y - thisHeight; }
        else { y = parent.y + parentHeight; }
      }
    }
    resolved.push({ part_id: part.part_id, color: part.color, x, y, z, rotation: part.rotation });
  }
  return resolved;
}

function toLDraw(resolved: ResolvedPart[]): string {
  const lines = ["0 FILE model.ldr", "0 Test build"];
  for (const part of resolved) {
    const rotMatrix = ROTATION_MATRICES[part.rotation] || ROTATION_MATRICES[0];
    lines.push(`1 ${part.color} ${part.x} ${part.y} ${part.z} ${rotMatrix} ${part.part_id}.dat`);
  }
  lines.push("0 STEP", "0 NOFILE");
  return lines.join("\n");
}

function render(mpdPath: string, outputPath: string): boolean {
  const ldviewBin = "/Applications/LDView-4.5.app/Contents/MacOS/LDView";
  if (!fs.existsSync(ldviewBin)) return false;
  const ldrawDir = process.env.LDRAW_DIR || process.env.LDRAWDIR || path.join(process.env.HOME || "", "ldraw");
  spawnSync(ldviewBin, [mpdPath, `-LDrawDir=${ldrawDir}`, `-SaveSnapshot=${outputPath}`,
    "-SaveWidth=400", "-SaveHeight=400", "-DefaultLatLong=45,315", "-SaveActualSize=0", "-AutoCrop=0", "-ShowErrors=0"], { timeout: 15000 });
  return fs.existsSync(outputPath);
}

type TC = { name: string; desc: string; parts: ConnectedPart[] };
const t: TC[] = [
  // 1-10: Basic stacking
  { name: "001_2x2_stack2", desc: "Two 2x2 bricks stacked", parts: [
    { part_id: "3003", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 14, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "002_2x2_stack3", desc: "Three 2x2 bricks stacked", parts: [
    { part_id: "3003", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 14, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "003_2x2_stack4", desc: "Four 2x2 bricks stacked", parts: [
    { part_id: "3003", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 14, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 2, attach_to: 2, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "004_plate_stack3", desc: "Three 2x2 plates stacked", parts: [
    { part_id: "3022", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3022", color: 14, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3022", color: 1, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "005_plate_brick", desc: "Plate then brick", parts: [
    { part_id: "3022", color: 7, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "006_brick_plate", desc: "Brick then plate", parts: [
    { part_id: "3003", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3022", color: 14, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "007_1x1_stack3", desc: "Three 1x1 bricks stacked", parts: [
    { part_id: "3005", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 14, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 1, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "008_2x4_stack2", desc: "Two 2x4 bricks stacked", parts: [
    { part_id: "3001", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 4, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "009_1x4_stack2", desc: "Two 1x4 bricks stacked", parts: [
    { part_id: "3010", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3010", color: 4, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "010_mixed_stack", desc: "2x4, 2x2, 1x1 stacked", parts: [
    { part_id: "3001", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 14, attach_to: 1, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 0 }]},
  // 11-20: Offsets
  { name: "011_offset_x2", desc: "2x2 offset 1 stud right", parts: [
    { part_id: "3003", color: 15, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 0, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "012_offset_z2", desc: "2x2 offset 1 stud forward", parts: [
    { part_id: "3003", color: 15, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 2, attach_to: 0, offset_x: 0, offset_z: 2, stack: "on_top", rotation: 0 }]},
  { name: "013_offset_neg", desc: "2x2 offset 1 stud left", parts: [
    { part_id: "3003", color: 15, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 0, offset_x: -2, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "014_offset_diag", desc: "2x2 diagonal 1 stud (1-stud connection)", parts: [
    { part_id: "3003", color: 15, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 0, offset_x: 2, offset_z: 2, stack: "on_top", rotation: 0 }]},
  { name: "015_1x1_on_2x2", desc: "1x1 on corner of 2x2", parts: [
    { part_id: "3003", color: 15, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 4, attach_to: 0, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 0 }]},
  { name: "016_1x1_corners", desc: "1x1 on all 4 corners of 2x2", parts: [
    { part_id: "3003", color: 15, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 4, attach_to: 0, offset_x: -1, offset_z: -1, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 4, attach_to: 0, offset_x: 1, offset_z: -1, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 4, attach_to: 0, offset_x: -1, offset_z: 1, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 4, attach_to: 0, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 0 }]},
  { name: "017_4x4_corners", desc: "1x1 on corners of 4x4 plate", parts: [
    { part_id: "3031", color: 15, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 4, attach_to: 0, offset_x: -3, offset_z: -3, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 4, attach_to: 0, offset_x: 3, offset_z: -3, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 4, attach_to: 0, offset_x: -3, offset_z: 3, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 4, attach_to: 0, offset_x: 3, offset_z: 3, stack: "on_top", rotation: 0 }]},
  { name: "018_2x4_offset", desc: "2x2 offset on 2x4", parts: [
    { part_id: "3001", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 0, offset_x: 0, offset_z: 2, stack: "on_top", rotation: 0 }]},
  { name: "019_chain_offset", desc: "Chain of 2x2 each offset +1Z", parts: [
    { part_id: "3003", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 14, attach_to: 0, offset_x: 0, offset_z: 2, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 2, attach_to: 1, offset_x: 0, offset_z: 2, stack: "on_top", rotation: 0 }]},
  { name: "020_chain_diag", desc: "Diagonal chain (1-stud each)", parts: [
    { part_id: "3003", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 14, attach_to: 0, offset_x: 2, offset_z: 2, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 2, attach_to: 1, offset_x: 2, offset_z: 2, stack: "on_top", rotation: 0 }]},
  // 21-30: Rotations
  { name: "021_rot90_1x2", desc: "1x2 rotated 90 on 2x2", parts: [
    { part_id: "3003", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3004", color: 4, attach_to: 0, offset_x: 1, offset_z: 0, stack: "on_top", rotation: 90 }]},
  { name: "022_rot180_2x4", desc: "2x4 rotated 180 on 2x4", parts: [
    { part_id: "3001", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 4, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 180 }]},
  { name: "023_rot90_2x4", desc: "2x4 rotated 90 on 2x4 (cross)", parts: [
    { part_id: "3001", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 4, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 90 }]},
  { name: "024_rot270", desc: "1x2 rotated 270 on 2x2", parts: [
    { part_id: "3003", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3004", color: 4, attach_to: 0, offset_x: -1, offset_z: 0, stack: "on_top", rotation: 270 }]},
  { name: "025_1x4_rot90", desc: "1x4 rotated 90 on 1x4 (cross)", parts: [
    { part_id: "3010", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3010", color: 4, attach_to: 0, offset_x: 1, offset_z: -1, stack: "on_top", rotation: 90 }]},
  { name: "026_multi_rot", desc: "Stack with alternating rotations", parts: [
    { part_id: "3001", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 4, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 90 },
    { part_id: "3001", color: 2, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "027_1x2_pair_rot", desc: "Two 1x2 rotated on 2x4", parts: [
    { part_id: "3001", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3004", color: 4, attach_to: 0, offset_x: -1, offset_z: 0, stack: "on_top", rotation: 90 },
    { part_id: "3004", color: 4, attach_to: 0, offset_x: 1, offset_z: 0, stack: "on_top", rotation: 90 }]},
  { name: "028_rot_offset", desc: "Rotated + offset combo", parts: [
    { part_id: "3003", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3004", color: 4, attach_to: 0, offset_x: 1, offset_z: 0, stack: "on_top", rotation: 90 }]},
  { name: "029_1x1_rot", desc: "1x1 rotation (no visual change)", parts: [
    { part_id: "3005", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 4, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 90 }]},
  { name: "030_2x2_rot", desc: "2x2 rotation (no visual change)", parts: [
    { part_id: "3003", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 90 }]},
  // 31-40: L-shapes and branches
  { name: "031_L_simple", desc: "Simple L shape", parts: [
    { part_id: "3003", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 1, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "032_T_shape", desc: "T shape", parts: [
    { part_id: "3003", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 0, offset_x: -2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 0, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "033_plus_shape", desc: "Plus/cross shape", parts: [
    { part_id: "3003", color: 15, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 0, offset_x: -2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 0, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 0, offset_x: 0, offset_z: -2, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 0, offset_x: 0, offset_z: 2, stack: "on_top", rotation: 0 }]},
  { name: "034_branch_up", desc: "Branch going up", parts: [
    { part_id: "3003", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 0, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 14, attach_to: 1, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 0 }]},
  { name: "035_Y_shape", desc: "Y shape from top", parts: [
    { part_id: "3003", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 0, offset_x: -2, offset_z: 2, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 0, offset_x: 2, offset_z: 2, stack: "on_top", rotation: 0 }]},
  { name: "036_corner", desc: "Corner build", parts: [
    { part_id: "3001", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 1, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 90 }]},
  { name: "037_step_L", desc: "Stepped L", parts: [
    { part_id: "3003", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 0, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 1, offset_x: 0, offset_z: 2, stack: "on_top", rotation: 0 }]},
  { name: "038_zigzag", desc: "Zigzag pattern", parts: [
    { part_id: "3003", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 14, attach_to: 0, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 1, offset_x: 0, offset_z: 2, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 14, attach_to: 2, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "039_H_shape", desc: "H shape", parts: [
    { part_id: "3003", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: null, offset_x: 6, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 2, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 2, attach_to: 1, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "040_bridge", desc: "Bridge/span", parts: [
    { part_id: "3003", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: null, offset_x: 4, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 4, attach_to: 0, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 }]},
  // 41-50: Towers and height
  { name: "041_tower5", desc: "5-high tower", parts: [
    { part_id: "3003", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 14, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 2, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 2, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 15, attach_to: 3, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "042_1x1_tower", desc: "1x1 tower 5 high", parts: [
    { part_id: "3005", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 14, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 2, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 1, attach_to: 2, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 15, attach_to: 3, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "043_pyramid", desc: "Simple pyramid (4x4, 2x2, 1x1)", parts: [
    { part_id: "3031", color: 7, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 14, attach_to: 1, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 0 }]},
  { name: "044_tapered", desc: "Tapered tower", parts: [
    { part_id: "3001", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 14, attach_to: 1, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 0 }]},
  { name: "045_wide_tower", desc: "Wide base tower", parts: [
    { part_id: "3031", color: 7, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3031", color: 7, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "046_double_tower", desc: "Two towers side by side", parts: [
    { part_id: "3003", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: null, offset_x: 4, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 2, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "047_staircase", desc: "Stair steps going up", parts: [
    { part_id: "3022", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3022", color: 4, attach_to: 0, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3022", color: 4, attach_to: 1, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3022", color: 4, attach_to: 2, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "048_spiral", desc: "Spiral-ish tower", parts: [
    { part_id: "3003", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 14, attach_to: 0, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 2, attach_to: 1, offset_x: 0, offset_z: 2, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 2, offset_x: -2, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "049_alternating", desc: "Alternating offset tower", parts: [
    { part_id: "3003", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 14, attach_to: 0, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 1, offset_x: -2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 14, attach_to: 2, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "050_cantilever", desc: "Cantilever overhang", parts: [
    { part_id: "3003", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 4, attach_to: 1, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 }]},
];

// Continue with 51-100
const t2: TC[] = [
  // 51-60: Plates and thin builds
  { name: "051_plate_floor", desc: "2x2 plates as floor 2x2", parts: [
    { part_id: "3022", color: 7, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3022", color: 7, attach_to: null, offset_x: 4, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3022", color: 7, attach_to: null, offset_x: 0, offset_z: 4, stack: "on_top", rotation: 0 },
    { part_id: "3022", color: 7, attach_to: null, offset_x: 4, offset_z: 4, stack: "on_top", rotation: 0 }]},
  { name: "052_thick_plate", desc: "3 plates = 1 brick height", parts: [
    { part_id: "3022", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3022", color: 14, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3022", color: 1, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 2, attach_to: 2, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "053_plate_stripe", desc: "Stripe of plates", parts: [
    { part_id: "3023", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3023", color: 14, attach_to: 0, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3023", color: 4, attach_to: 1, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3023", color: 14, attach_to: 2, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "054_plate_1x1", desc: "1x1 plates stacked", parts: [
    { part_id: "3024", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3024", color: 14, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3024", color: 1, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "055_plate_on_brick", desc: "Plate layer on brick", parts: [
    { part_id: "3003", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3022", color: 4, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "056_1x4_plate", desc: "1x4 plates", parts: [
    { part_id: "3710", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3710", color: 14, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "057_plate_L", desc: "L of plates", parts: [
    { part_id: "3023", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3023", color: 4, attach_to: 0, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3023", color: 4, attach_to: 0, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 90 }]},
  { name: "058_sandwich", desc: "Brick sandwiched by plates", parts: [
    { part_id: "3022", color: 7, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3022", color: 7, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "059_offset_plates", desc: "Offset plates pattern", parts: [
    { part_id: "3022", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3022", color: 14, attach_to: 0, offset_x: 2, offset_z: 2, stack: "on_top", rotation: 0 }]},
  { name: "060_plate_grid", desc: "2x2 grid of 1x1 plates", parts: [
    { part_id: "3024", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3024", color: 14, attach_to: null, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3024", color: 14, attach_to: null, offset_x: 0, offset_z: 2, stack: "on_top", rotation: 0 },
    { part_id: "3024", color: 4, attach_to: null, offset_x: 2, offset_z: 2, stack: "on_top", rotation: 0 }]},
  // 61-70: Complex shapes
  { name: "061_box_open", desc: "Open box (4 walls)", parts: [
    { part_id: "3001", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 1, attach_to: null, offset_x: 0, offset_z: 4, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 1, attach_to: 0, offset_x: -2, offset_z: 2, stack: "on_top", rotation: 90 },
    { part_id: "3001", color: 1, attach_to: 0, offset_x: 2, offset_z: 2, stack: "on_top", rotation: 90 }]},
  { name: "062_stairs3", desc: "3-step stairs", parts: [
    { part_id: "3003", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 0, offset_x: 0, offset_z: 2, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 1, offset_x: 0, offset_z: 2, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 3, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "063_wall", desc: "Wall section", parts: [
    { part_id: "3001", color: 15, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 15, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 15, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "064_corner_wall", desc: "Corner walls", parts: [
    { part_id: "3001", color: 15, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 15, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 90 }]},
  { name: "065_arch_base", desc: "Arch pillars", parts: [
    { part_id: "3003", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: null, offset_x: 6, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 2, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 4, attach_to: 1, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "066_platform", desc: "Elevated platform", parts: [
    { part_id: "3005", color: 1, attach_to: null, offset_x: -3, offset_z: -3, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 1, attach_to: null, offset_x: 3, offset_z: -3, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 1, attach_to: null, offset_x: -3, offset_z: 3, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 1, attach_to: null, offset_x: 3, offset_z: 3, stack: "on_top", rotation: 0 },
    { part_id: "3031", color: 7, attach_to: 0, offset_x: 3, offset_z: 3, stack: "on_top", rotation: 0 }]},
  { name: "067_cross_beam", desc: "Cross beams", parts: [
    { part_id: "3010", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3010", color: 4, attach_to: 0, offset_x: 1, offset_z: -1, stack: "on_top", rotation: 90 }]},
  { name: "068_fence", desc: "Fence posts with rails", parts: [
    { part_id: "3005", color: 6, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 6, attach_to: null, offset_x: 4, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 6, attach_to: null, offset_x: 8, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3024", color: 6, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3024", color: 6, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3024", color: 6, attach_to: 2, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "069_checkerboard", desc: "Checkerboard 2x2", parts: [
    { part_id: "3024", color: 15, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3024", color: 0, attach_to: null, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3024", color: 0, attach_to: null, offset_x: 0, offset_z: 2, stack: "on_top", rotation: 0 },
    { part_id: "3024", color: 15, attach_to: null, offset_x: 2, offset_z: 2, stack: "on_top", rotation: 0 }]},
  { name: "070_table", desc: "Simple table", parts: [
    { part_id: "3005", color: 6, attach_to: null, offset_x: -1, offset_z: -1, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 6, attach_to: null, offset_x: 1, offset_z: -1, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 6, attach_to: null, offset_x: -1, offset_z: 1, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 6, attach_to: null, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 6, attach_to: 0, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 0 }]},
  // 71-80: Color patterns
  { name: "071_rainbow", desc: "Rainbow tower", parts: [
    { part_id: "3003", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 25, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 14, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 2, attach_to: 2, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 3, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "072_stripe_h", desc: "Horizontal stripes", parts: [
    { part_id: "3001", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 15, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 4, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "073_two_tone", desc: "Two-tone split", parts: [
    { part_id: "3003", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: null, offset_x: 4, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "074_dots", desc: "Dots on plate", parts: [
    { part_id: "3031", color: 15, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3024", color: 4, attach_to: 0, offset_x: -1, offset_z: -1, stack: "on_top", rotation: 0 },
    { part_id: "3024", color: 4, attach_to: 0, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 0 }]},
  { name: "075_frame", desc: "Color frame", parts: [
    { part_id: "3005", color: 4, attach_to: null, offset_x: -1, offset_z: -1, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 4, attach_to: null, offset_x: 1, offset_z: -1, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 4, attach_to: null, offset_x: -1, offset_z: 1, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 4, attach_to: null, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 14, attach_to: 0, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 0 }]},
  { name: "076_gradient", desc: "Gray gradient", parts: [
    { part_id: "3003", color: 0, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 8, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 7, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 15, attach_to: 2, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "077_ring", desc: "Ring of 1x1s", parts: [
    { part_id: "3022", color: 7, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 4, attach_to: 0, offset_x: -1, offset_z: -1, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 4, attach_to: 0, offset_x: 1, offset_z: -1, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 4, attach_to: 0, offset_x: -1, offset_z: 1, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 4, attach_to: 0, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 0 }]},
  { name: "078_bullseye", desc: "Target pattern", parts: [
    { part_id: "3003", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3022", color: 15, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 4, attach_to: 1, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 0 }]},
  { name: "079_flag", desc: "Simple flag", parts: [
    { part_id: "3005", color: 0, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 0, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 0, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3022", color: 4, attach_to: 2, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 0 }]},
  { name: "080_layers", desc: "Layered colors", parts: [
    { part_id: "3031", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3022", color: 4, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3024", color: 14, attach_to: 1, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 0 }]},
  // 81-90: Multi-part complex
  { name: "081_house_base", desc: "House foundation", parts: [
    { part_id: "3001", color: 7, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 7, attach_to: null, offset_x: 0, offset_z: 4, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 7, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 7, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "082_chimney", desc: "Chimney stack", parts: [
    { part_id: "3003", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 0, attach_to: 0, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 0, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "083_tree_base", desc: "Tree trunk", parts: [
    { part_id: "3003", color: 6, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 6, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 2, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 2, attach_to: 2, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 0 }]},
  { name: "084_car_base", desc: "Car chassis", parts: [
    { part_id: "3001", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 0, attach_to: 0, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 0 }]},
  { name: "085_robot", desc: "Simple robot", parts: [
    { part_id: "3003", color: 7, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 7, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 1, attach_to: 1, offset_x: -1, offset_z: 1, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 1, attach_to: 1, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 0 }]},
  { name: "086_rocket", desc: "Simple rocket", parts: [
    { part_id: "3003", color: 15, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 15, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 4, attach_to: 1, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 0 }]},
  { name: "087_castle_tower", desc: "Castle tower", parts: [
    { part_id: "3003", color: 7, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 7, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 7, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 7, attach_to: 2, offset_x: -1, offset_z: -1, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 7, attach_to: 2, offset_x: 1, offset_z: -1, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 7, attach_to: 2, offset_x: -1, offset_z: 1, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 7, attach_to: 2, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 0 }]},
  { name: "088_boat", desc: "Boat hull", parts: [
    { part_id: "3001", color: 6, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3004", color: 6, attach_to: 0, offset_x: 0, offset_z: 1, stack: "on_top", rotation: 0 }]},
  { name: "089_lamp", desc: "Street lamp", parts: [
    { part_id: "3005", color: 0, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 0, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 0, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3024", color: 14, attach_to: 2, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "090_bench", desc: "Park bench", parts: [
    { part_id: "3005", color: 6, attach_to: null, offset_x: -3, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 6, attach_to: null, offset_x: 3, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3010", color: 6, attach_to: 0, offset_x: 3, offset_z: 0, stack: "on_top", rotation: 0 }]},
  // 91-100: Edge cases and stress tests
  { name: "091_max_height", desc: "Tall tower 7 high", parts: [
    { part_id: "3003", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 14, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 2, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 2, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 15, attach_to: 3, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 7, attach_to: 4, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 0, attach_to: 5, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "092_wide_span", desc: "Wide bridge", parts: [
    { part_id: "3003", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: null, offset_x: 8, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 7, attach_to: 0, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 7, attach_to: 2, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "093_deep_branch", desc: "Many levels of branching", parts: [
    { part_id: "3003", color: 1, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 0, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 14, attach_to: 1, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 2, attach_to: 2, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 15, attach_to: 3, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 0 }]},
  { name: "094_mix_all", desc: "Mix of all part types", parts: [
    { part_id: "3031", color: 7, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 1, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3004", color: 14, attach_to: 2, offset_x: 1, offset_z: 0, stack: "on_top", rotation: 90 },
    { part_id: "3005", color: 2, attach_to: 2, offset_x: -1, offset_z: -1, stack: "on_top", rotation: 0 }]},
  { name: "095_negative", desc: "All negative offsets", parts: [
    { part_id: "3003", color: 15, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 4, attach_to: 0, offset_x: -2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 14, attach_to: 1, offset_x: 0, offset_z: -2, stack: "on_top", rotation: 0 }]},
  { name: "096_max_offset", desc: "Large diagonal offset (1 stud)", parts: [
    { part_id: "3003", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 14, attach_to: 0, offset_x: 2, offset_z: 2, stack: "on_top", rotation: 0 }]},
  { name: "097_multi_base", desc: "Multiple base parts", parts: [
    { part_id: "3003", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 14, attach_to: null, offset_x: 4, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 2, attach_to: null, offset_x: 0, offset_z: 4, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: null, offset_x: 4, offset_z: 4, stack: "on_top", rotation: 0 }]},
  { name: "098_interlock", desc: "Interlocking pattern", parts: [
    { part_id: "3001", color: 4, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 14, attach_to: 0, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 4, attach_to: 1, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "099_symmetry", desc: "Symmetric build", parts: [
    { part_id: "3003", color: 15, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 4, attach_to: 0, offset_x: -1, offset_z: -1, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 4, attach_to: 0, offset_x: 1, offset_z: -1, stack: "on_top", rotation: 0 },
    { part_id: "3022", color: 14, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 }]},
  { name: "100_finale", desc: "Complex finale build", parts: [
    { part_id: "3031", color: 7, attach_to: null, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 0, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 1, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 1, offset_x: 0, offset_z: 2, stack: "on_top", rotation: 0 },
    { part_id: "3003", color: 1, attach_to: 1, offset_x: 0, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3001", color: 4, attach_to: 4, offset_x: 2, offset_z: 0, stack: "on_top", rotation: 0 },
    { part_id: "3005", color: 14, attach_to: 5, offset_x: 1, offset_z: 1, stack: "on_top", rotation: 0 }]},
];

const testCases = [...t, ...t2];
const outDir = path.join(process.cwd(), "data", "test-renders");
fs.mkdirSync(outDir, { recursive: true });

console.log(`\nValidating and generating ${testCases.length} test renders...\n`);
let passed = 0, failed = 0, invalid = 0;
const invalidTests: string[] = [];

for (const tc of testCases) {
  // Validate connections first
  const validation = validateBuild(tc.parts);
  if (!validation.valid) {
    invalid++;
    invalidTests.push(`${tc.name}:\n  ${validation.errors.join("\n  ")}`);
    console.log(`⚠ ${tc.name} INVALID CONNECTION`);
    for (const err of validation.errors) {
      console.log(`    ${err}`);
    }
    continue;
  }
  
  const resolved = resolveConnections(tc.parts);
  const ldraw = toLDraw(resolved);
  const mpdPath = path.join(outDir, `${tc.name}.mpd`);
  const pngPath = path.join(outDir, `${tc.name}.png`);
  fs.writeFileSync(mpdPath, ldraw, "utf8");
  if (render(mpdPath, pngPath)) { passed++; console.log(`✓ ${tc.name}`); }
  else { failed++; console.log(`✗ ${tc.name} RENDER FAILED`); }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} render failed, ${invalid} invalid connections`);
if (invalidTests.length > 0) {
  console.log(`\nInvalid builds:\n${invalidTests.join("\n\n")}`);
}
console.log(`\nImages in: ${outDir}`);
