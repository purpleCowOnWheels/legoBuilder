/**
 * Unified Render Validation Module
 * 
 * Combines all validation checks into a single interface that can be:
 * 1. Called directly from the tool loop
 * 2. Wrapped as an MCP tool for remote validation
 * 
 * All inputs/outputs are JSON-serializable for MCP compatibility.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { compareImages, type SimilarityScore } from "@/lib/imageSimilarity";
import { 
  executeLPub3D, 
  getLPub3DBin, 
  isLPub3DAvailable,
  killOrphanedLPub3DProcesses,
  diagnoseRenderFailure,
  type LPub3DExecResult,
  type LPub3DError,
  type RenderDiagnostic
} from "@/lib/lpub3d";
import {
  validateLDrawMpdOrThrow,
  validateLDrawPartialMpdOrThrow,
  validateLDrawStructure,
  type LDInspectorResult
} from "@/lib/ldrawValidate";
import {
  validateSubmoduleSemantic,
  validateFinalModelSemantic,
  isSemanticValidationAvailable,
  type SubmoduleSemanticResult,
  type FinalSemanticResult,
  type SubassemblyInfo,
  type BlueprintStep,
  type Blueprint
} from "@/lib/semanticValidator";

// ============================================================================
// Types (MCP-friendly: all JSON-serializable)
// ============================================================================

export interface BlueprintSubassembly {
  name: string;
  description: string;
  /** Which step numbers belong to this subassembly (1-based) */
  steps?: number[];
  /** Expected position relative to model: "top", "bottom", "left", "right", "front", "back", "center" */
  expected_position?: string;
  /** Should this subassembly have a symmetric counterpart? */
  symmetric?: boolean;
}

export interface BlueprintInfo {
  subassemblies: BlueprintSubassembly[];
  step_outline: Array<{
    step: number;
    title: string;
    description: string;
    /** Which subassembly this step belongs to */
    subassembly?: string;
  }>;
}

export interface RenderValidationInput {
  /** The LDraw MPD content to validate */
  ldraw_mpd: string;
  
  /** Path to reference image (PNG) to compare against */
  reference_image_path?: string;
  
  /** Validation mode */
  mode: "full" | "partial" | "chunk";
  
  /** For chunk mode: which blueprint steps this chunk covers */
  step_from?: number;
  step_to?: number;
  
  /** Minimum similarity threshold (0-100). Default: 60 */
  min_similarity?: number;
  
  /** Whether to render and compare (requires LPub3D). Default: true if reference provided */
  do_render_comparison?: boolean;
  
  /** Render size in pixels. Default: 512 */
  render_size?: number;
  
  /** Blueprint info for subassembly validation */
  blueprint?: BlueprintInfo;
  
  /** Which subassembly is being built in this chunk (for targeted validation) */
  current_subassembly?: string;
  
  /** Always render for logging purposes, even if no comparison is done. Default: false */
  always_render_for_logging?: boolean;
  
  /** Round number (for logging purposes) */
  validation_round?: number;
}

export interface StructureIssue {
  type: "syntax" | "missing_parts" | "invalid_coords" | "collision" | "continuity" | "other";
  severity: "error" | "warning";
  message: string;
  line_number?: number;
  part_id?: string;
}

export interface SubassemblyValidationResult {
  name: string;
  valid: boolean;
  issues: StructureIssue[];
  /** Bounding box of the subassembly (LDU) */
  bounds?: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
    center: { x: number; y: number; z: number };
    size: { x: number; y: number; z: number };
  };
  /** Position assessment */
  position?: {
    relative_to_model: string; // "top", "bottom", "left", "right", "center", etc.
    attachment_valid: boolean;
  };
}

export interface RenderValidationResult {
  /** Overall pass/fail */
  valid: boolean;
  
  /** Why it failed (if valid=false) */
  failure_reason?: string;
  
  /** Structure validation results */
  structure: {
    valid: boolean;
    issues: StructureIssue[];
  };
  
  /** Image similarity results (if render comparison was done) */
  similarity?: {
    score: number; // 0-100
    passes_threshold: boolean;
    threshold: number;
    method: "python" | "imageMagick" | "basic" | "skipped";
    metrics?: {
      ssim?: number;
      mse?: number;
      psnr?: number;
    };
  };
  
  /** Continuity checks (parts connect properly, no floating pieces) */
  continuity: {
    valid: boolean;
    issues: StructureIssue[];
  };
  
  /** Collision detection results (if available) */
  collisions?: {
    checked: boolean;
    valid: boolean;
    issues: StructureIssue[];
  };
  
  /** Subassembly validation results (if blueprint provided) */
  subassemblies?: {
    checked: boolean;
    valid: boolean;
    results: SubassemblyValidationResult[];
    issues: StructureIssue[];
  };
  
  /** Path to rendered image (if render was done) */
  rendered_image_path?: string;
  
  /** Rendered image as base64 (for MCP response) */
  rendered_image_base64?: string;
  
  /** Execution metadata */
  meta: {
    duration_ms: number;
    checks_run: string[];
    ldraw_line_count: number;
    ldraw_part_count: number;
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

function countParts(ldrawMpd: string): number {
  const lines = ldrawMpd.split(/\r?\n/);
  return lines.filter(line => /^\s*1\s+/.test(line)).length;
}

function countLines(ldrawMpd: string): number {
  return ldrawMpd.split(/\r?\n/).length;
}

interface PartPlacement {
  line: number;
  step: number; // Which step this part belongs to (1-based)
  x: number;
  y: number;
  z: number;
  partId: string;
  color: number;
  raw: string;
}

/**
 * Parse MPD and extract all part placements with step assignments
 */
function parsePartsWithSteps(ldrawMpd: string): PartPlacement[] {
  const lines = ldrawMpd.split(/\r?\n/);
  const parts: PartPlacement[] = [];
  let currentStep = 1;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Track step transitions
    if (/^0\s+STEP\s*$/i.test(line)) {
      currentStep++;
      continue;
    }
    
    // Parse type-1 lines (part placements)
    if (!line.startsWith("1 ")) continue;
    
    const tokens = line.split(/\s+/);
    if (tokens.length < 15) continue;
    
    const color = parseInt(tokens[1], 10);
    const x = parseFloat(tokens[2]);
    const y = parseFloat(tokens[3]);
    const z = parseFloat(tokens[4]);
    const partId = tokens[14];
    
    if (isNaN(x) || isNaN(y) || isNaN(z)) continue;
    
    parts.push({ line: i + 1, step: currentStep, x, y, z, partId, color, raw: line });
  }
  
  return parts;
}

/**
 * Compute bounding box for a set of parts
 */
function computeBounds(parts: PartPlacement[]): {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
  center: { x: number; y: number; z: number };
  size: { x: number; y: number; z: number };
} | null {
  if (parts.length === 0) return null;
  
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  
  for (const p of parts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    minZ = Math.min(minZ, p.z);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
    maxZ = Math.max(maxZ, p.z);
  }
  
  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
    center: {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      z: (minZ + maxZ) / 2
    },
    size: {
      x: maxX - minX,
      y: maxY - minY,
      z: maxZ - minZ
    }
  };
}

/**
 * Determine relative position of a subassembly within the model
 * For symmetric subassemblies, also checks if parts span both sides
 */
function determineRelativePosition(
  subassemblyBounds: ReturnType<typeof computeBounds>,
  modelBounds: ReturnType<typeof computeBounds>,
  parts?: PartPlacement[],
  isSymmetric?: boolean
): string {
  if (!subassemblyBounds || !modelBounds) return "unknown";
  
  // For symmetric subassemblies, check if parts span both left and right
  if (isSymmetric && parts && parts.length > 1) {
    const modelCenterX = modelBounds.center.x;
    const leftParts = parts.filter(p => p.x < modelCenterX - 10);
    const rightParts = parts.filter(p => p.x > modelCenterX + 10);
    
    if (leftParts.length > 0 && rightParts.length > 0) {
      // Parts on both sides = "sides" (valid for symmetric wing-like structures)
      return "sides";
    }
  }
  
  const sub = subassemblyBounds.center;
  const model = modelBounds.center;
  const modelSize = modelBounds.size;
  
  // Calculate normalized offset from model center
  const dx = modelSize.x > 0 ? (sub.x - model.x) / modelSize.x : 0;
  const dy = modelSize.y > 0 ? (sub.y - model.y) / modelSize.y : 0;
  const dz = modelSize.z > 0 ? (sub.z - model.z) / modelSize.z : 0;
  
  // Note: LDraw Y is inverted (negative is up)
  const positions: string[] = [];
  
  if (dy < -0.25) positions.push("top");
  if (dy > 0.25) positions.push("bottom");
  if (dx < -0.25) positions.push("left");
  if (dx > 0.25) positions.push("right");
  if (dz < -0.25) positions.push("back");
  if (dz > 0.25) positions.push("front");
  
  if (positions.length === 0) return "center";
  return positions.join("-");
}

/**
 * Check if expected position matches actual position
 */
function positionMatches(expected: string | undefined, actual: string, isSymmetric?: boolean): boolean {
  if (!expected) return true; // No expectation = always valid
  
  const expectedNorm = expected.toLowerCase().trim();
  const actualNorm = actual.toLowerCase().trim();
  
  // Exact match
  if (expectedNorm === actualNorm) return true;
  
  // Partial match (e.g., "top" matches "top-left")
  if (actualNorm.includes(expectedNorm)) return true;
  if (expectedNorm.includes(actualNorm)) return true;
  
  // For symmetric subassemblies: "sides" matches "left", "right", or "left-right"
  if (isSymmetric && actualNorm === "sides") {
    if (expectedNorm === "left" || expectedNorm === "right" || expectedNorm.includes("side")) {
      return true;
    }
  }
  
  // "left" or "right" expected, "sides" actual (symmetric pair)
  if ((expectedNorm === "left" || expectedNorm === "right") && actualNorm === "sides") {
    return true;
  }
  
  return false;
}

/**
 * Validate subassemblies based on blueprint
 */
function validateSubassemblies(
  ldrawMpd: string,
  blueprint: BlueprintInfo,
  currentSubassembly?: string
): { results: SubassemblyValidationResult[]; issues: StructureIssue[] } {
  const results: SubassemblyValidationResult[] = [];
  const issues: StructureIssue[] = [];
  
  const allParts = parsePartsWithSteps(ldrawMpd);
  if (allParts.length === 0) {
    return { results, issues };
  }
  
  const modelBounds = computeBounds(allParts);
  
  // Map steps to subassemblies based on step_outline
  const stepToSubassembly: Map<number, string> = new Map();
  for (const step of blueprint.step_outline) {
    if (step.subassembly) {
      stepToSubassembly.set(step.step, step.subassembly);
    }
  }
  
  // If step_outline doesn't have subassembly assignments, try to infer from titles
  if (stepToSubassembly.size === 0) {
    for (const step of blueprint.step_outline) {
      const title = step.title.toLowerCase();
      for (const sub of blueprint.subassemblies) {
        if (title.includes(sub.name.toLowerCase())) {
          stepToSubassembly.set(step.step, sub.name);
          break;
        }
      }
    }
  }
  
  // Group parts by subassembly
  const subassemblyParts: Map<string, PartPlacement[]> = new Map();
  for (const part of allParts) {
    const subName = stepToSubassembly.get(part.step);
    if (subName) {
      if (!subassemblyParts.has(subName)) {
        subassemblyParts.set(subName, []);
      }
      subassemblyParts.get(subName)!.push(part);
    }
  }
  
  // Validate each subassembly
  for (const subDef of blueprint.subassemblies) {
    // Skip if we're only validating current subassembly
    if (currentSubassembly && subDef.name.toLowerCase() !== currentSubassembly.toLowerCase()) {
      continue;
    }
    
    const parts = subassemblyParts.get(subDef.name) || [];
    const subResult: SubassemblyValidationResult = {
      name: subDef.name,
      valid: true,
      issues: []
    };
    
    if (parts.length === 0) {
      // Subassembly has no parts yet - might be built in later chunks
      subResult.issues.push({
        type: "other",
        severity: "warning",
        message: `Subassembly "${subDef.name}" has no parts assigned yet`
      });
    } else {
      const bounds = computeBounds(parts);
      subResult.bounds = bounds || undefined;
      
      if (bounds && modelBounds) {
        const relPos = determineRelativePosition(bounds, modelBounds, parts, subDef.symmetric);
        const posValid = positionMatches(subDef.expected_position, relPos, subDef.symmetric);
        
        subResult.position = {
          relative_to_model: relPos,
          attachment_valid: posValid
        };
        
        if (!posValid && subDef.expected_position) {
          subResult.valid = false;
          subResult.issues.push({
            type: "continuity",
            severity: "error",
            message: `Subassembly "${subDef.name}" is at "${relPos}" but expected "${subDef.expected_position}"`
          });
        }
        
        // Check proportions - subassembly shouldn't be absurdly larger than model
        const subVolume = bounds.size.x * bounds.size.y * bounds.size.z;
        const modelVolume = modelBounds.size.x * modelBounds.size.y * modelBounds.size.z;
        
        if (modelVolume > 0 && subVolume > modelVolume * 0.8) {
          subResult.issues.push({
            type: "continuity",
            severity: "warning",
            message: `Subassembly "${subDef.name}" is unusually large (${Math.round(subVolume / modelVolume * 100)}% of model volume)`
          });
        }
        
        // Check for extreme proportions within subassembly
        const maxDim = Math.max(bounds.size.x, bounds.size.y, bounds.size.z);
        const minDim = Math.min(bounds.size.x, bounds.size.y, bounds.size.z);
        if (minDim > 0 && maxDim / minDim > 20) {
          subResult.issues.push({
            type: "continuity",
            severity: "warning",
            message: `Subassembly "${subDef.name}" has extreme proportions (${Math.round(maxDim / minDim)}:1 aspect ratio)`
          });
        }
      }
      
      // Check symmetry if required
      if (subDef.symmetric) {
        // For symmetric subassemblies, check if parts are roughly mirrored
        const leftParts = parts.filter(p => p.x < 0);
        const rightParts = parts.filter(p => p.x > 0);
        const centerParts = parts.filter(p => Math.abs(p.x) < 10); // Within 10 LDU of center
        
        const leftCount = leftParts.length;
        const rightCount = rightParts.length;
        
        if (leftCount > 0 && rightCount > 0) {
          const asymmetry = Math.abs(leftCount - rightCount) / Math.max(leftCount, rightCount);
          if (asymmetry > 0.3) { // More than 30% difference
            subResult.issues.push({
              type: "continuity",
              severity: "warning",
              message: `Subassembly "${subDef.name}" should be symmetric but has ${leftCount} left parts vs ${rightCount} right parts`
            });
          }
        } else if (leftCount === 0 && rightCount === 0 && centerParts.length > 0) {
          // All parts in center - might be intentional for symmetric single item
        } else if ((leftCount === 0) !== (rightCount === 0)) {
          subResult.issues.push({
            type: "continuity",
            severity: "warning",
            message: `Subassembly "${subDef.name}" should be symmetric but parts are only on one side`
          });
        }
      }
    }
    
    // Update valid flag based on error issues
    subResult.valid = subResult.issues.filter(i => i.severity === "error").length === 0;
    results.push(subResult);
    
    // Add issues to main list
    for (const issue of subResult.issues) {
      issues.push(issue);
    }
  }
  
  // Check for unassigned parts (parts not belonging to any subassembly)
  const assignedSteps = new Set(stepToSubassembly.keys());
  const unassignedParts = allParts.filter(p => !assignedSteps.has(p.step));
  if (unassignedParts.length > allParts.length * 0.3) {
    issues.push({
      type: "other",
      severity: "warning",
      message: `${unassignedParts.length} parts (${Math.round(unassignedParts.length / allParts.length * 100)}%) are not assigned to any subassembly`
    });
  }
  
  return { results, issues };
}

/**
 * Check for continuity issues:
 * - Parts at non-standard Z heights (floating)
 * - Large gaps between parts
 * - Parts with no neighbors (isolated)
 */
function checkContinuity(ldrawMpd: string): StructureIssue[] {
  const issues: StructureIssue[] = [];
  const lines = ldrawMpd.split(/\r?\n/);
  
  // Extract all part placements with their positions
  const parts: Array<{
    line: number;
    x: number;
    y: number;
    z: number;
    partId: string;
    raw: string;
  }> = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("1 ")) continue;
    
    const tokens = line.split(/\s+/);
    if (tokens.length < 15) continue;
    
    // Type 1 line format: 1 <color> <x> <y> <z> <a> <b> <c> <d> <e> <f> <g> <h> <i> <part>
    const x = parseFloat(tokens[2]);
    const y = parseFloat(tokens[3]);
    const z = parseFloat(tokens[4]);
    const partId = tokens[14];
    
    if (isNaN(x) || isNaN(y) || isNaN(z)) {
      issues.push({
        type: "invalid_coords",
        severity: "error",
        message: `Invalid coordinates at line ${i + 1}: ${line.slice(0, 80)}`,
        line_number: i + 1
      });
      continue;
    }
    
    parts.push({ line: i + 1, x, y, z, partId, raw: line });
  }
  
  if (parts.length === 0) {
    return issues;
  }
  
  // Check 1: Y-coordinate alignment (LDraw Y is vertical, negative is up)
  // Standard plate height is 8 LDU, brick height is 24 LDU
  // Most parts should be at Y values divisible by 8
  const yValues = parts.map(p => p.y);
  const nonAlignedY = parts.filter(p => {
    const yMod8 = Math.abs(p.y % 8);
    return yMod8 > 0.01 && yMod8 < 7.99; // Allow small floating point errors
  });
  
  if (nonAlignedY.length > 0 && nonAlignedY.length <= 5) {
    // Only warn if it's a few parts (might be intentional angles)
    for (const p of nonAlignedY) {
      issues.push({
        type: "continuity",
        severity: "warning",
        message: `Part at non-standard Y height (${p.y}): ${p.partId}`,
        line_number: p.line,
        part_id: p.partId
      });
    }
  }
  
  // Check 2: X/Z alignment (stud grid is 20 LDU)
  const nonAlignedXZ = parts.filter(p => {
    const xMod = Math.abs(p.x % 10); // Half-stud is 10 LDU
    const zMod = Math.abs(p.z % 10);
    const xAligned = xMod < 0.01 || xMod > 9.99;
    const zAligned = zMod < 0.01 || zMod > 9.99;
    return !xAligned || !zAligned;
  });
  
  if (nonAlignedXZ.length > 0 && nonAlignedXZ.length <= 3) {
    for (const p of nonAlignedXZ) {
      issues.push({
        type: "continuity",
        severity: "warning",
        message: `Part at non-standard X/Z position (${p.x}, ${p.z}): ${p.partId}`,
        line_number: p.line,
        part_id: p.partId
      });
    }
  }
  
  // Check 3: Isolation detection (parts with no neighbors within reasonable distance)
  // A typical 2x4 brick is 40x24x20 LDU, so check within ~60 LDU
  const NEIGHBOR_THRESHOLD = 60;
  
  for (const part of parts) {
    const hasNeighbor = parts.some(other => {
      if (other === part) return false;
      const dx = Math.abs(part.x - other.x);
      const dy = Math.abs(part.y - other.y);
      const dz = Math.abs(part.z - other.z);
      return dx < NEIGHBOR_THRESHOLD && dy < NEIGHBOR_THRESHOLD && dz < NEIGHBOR_THRESHOLD;
    });
    
    if (!hasNeighbor && parts.length > 1) {
      issues.push({
        type: "continuity",
        severity: "warning",
        message: `Isolated part with no neighbors: ${part.partId} at (${part.x}, ${part.y}, ${part.z})`,
        line_number: part.line,
        part_id: part.partId
      });
    }
  }
  
  // Check 4: Extreme coordinate values (likely errors)
  const COORD_LIMIT = 10000; // Reasonable build shouldn't exceed this
  for (const p of parts) {
    if (Math.abs(p.x) > COORD_LIMIT || Math.abs(p.y) > COORD_LIMIT || Math.abs(p.z) > COORD_LIMIT) {
      issues.push({
        type: "continuity",
        severity: "error",
        message: `Part at extreme coordinates (${p.x}, ${p.y}, ${p.z}): ${p.partId}`,
        line_number: p.line,
        part_id: p.partId
      });
    }
  }
  
  return issues;
}

/**
 * Render MPD to PNG using LPub3D with retry and crash handling
 * Returns path to rendered image or null if rendering fails
 */
function renderMpdToPng(params: {
  ldrawMpd: string;
  outputDir: string;
  baseName: string;
  size: number;
  timeoutMs?: number;
  maxRetries?: number;
}): string | null {
  const { ldrawMpd, outputDir, baseName, size } = params;
  const timeoutMs = params.timeoutMs ?? 60000;
  const maxRetries = params.maxRetries ?? 2;
  
  // Write MPD to temp file
  fs.mkdirSync(outputDir, { recursive: true });
  const mpdPath = path.join(outputDir, `${baseName}.mpd`);
  const pngPath = path.join(outputDir, `${baseName}.png`);
  
  fs.writeFileSync(mpdPath, ldrawMpd, "utf8");
  
  // Count steps to render the final state
  const stepMatches = ldrawMpd.match(/^\s*0\s+STEP\s*$/gim);
  const totalSteps = stepMatches ? stepMatches.length + 1 : 1;
  
  // Try LPub3D first with proper crash handling
  if (isLPub3DAvailable()) {
    const args = [
      "--liblego",           // Use LEGO parts library
      "-i", pngPath,         // Output image path
      "-w", String(size),    // Width
      "-h", String(size),    // Height
      "--from", String(totalSteps),  // From step
      "--to", String(totalSteps),    // To step (render final state)
      "--viewpoint", "home", // Default viewpoint
      mpdPath                // Input file
    ];
    
    const result = executeLPub3D({
      args,
      cwd: outputDir,
      context: "validation render",
      timeoutMs,
      maxRetries,
      killOrphans: false  // Don't kill orphans for quick validation renders
    });
    
    if (fs.existsSync(pngPath)) {
      return pngPath;
    }
    
    // Log detailed failure info
    if (!result.success) {
      const errorType = result.error?.type || "unknown";
      const errorMsg = result.error?.message || "Unknown error";
      // eslint-disable-next-line no-console
      console.warn(`[renderValidation] LPub3D render failed (${errorType}, ${result.attempts} attempts): ${errorMsg}`);
      
      // If it was a crash, try killing orphans and retry once more
      if (result.error?.type === "crash" || result.error?.type === "timeout") {
        // eslint-disable-next-line no-console
        console.warn("[renderValidation] Attempting recovery after crash/timeout...");
        killOrphanedLPub3DProcesses();
        
        // One more attempt
        const retryResult = executeLPub3D({
          args,
          cwd: outputDir,
          context: "validation render (recovery)",
          timeoutMs,
          maxRetries: 0,  // No more retries
          killOrphans: false
        });
        
        if (fs.existsSync(pngPath)) {
          // eslint-disable-next-line no-console
          console.log("[renderValidation] Recovery render succeeded");
          return pngPath;
        }
        
        if (!retryResult.success) {
          // eslint-disable-next-line no-console
          console.warn(`[renderValidation] Recovery render also failed: ${retryResult.error?.message}`);
        }
      }
    }
  }
  
  // Try LDView as fallback
  const ldviewBin = process.env.LDVIEW_BIN || "/Applications/LDView.app/Contents/MacOS/LDView";
  
  if (fs.existsSync(ldviewBin)) {
    // LDView doesn't have the same crash issues, use simpler handling
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = spawnSync(ldviewBin, [
          mpdPath,
          `-SaveSnapshot=${pngPath}`,
          `-SaveWidth=${size}`,
          `-SaveHeight=${size}`,
          "-SaveAlpha=1"
        ], {
          encoding: "utf8",
          timeout: timeoutMs
        });
        
        if (fs.existsSync(pngPath)) {
          return pngPath;
        }
        
        // Log failure
        if (result.error || result.status !== 0) {
          // eslint-disable-next-line no-console
          console.warn(`[renderValidation] LDView render attempt ${attempt + 1} failed:`, 
            result.error?.message || `exit code ${result.status}`);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[renderValidation] LDView render exception (attempt ${attempt + 1}):`, e);
      }
      
      // Small delay before retry
      if (attempt < maxRetries) {
        const delayUntil = Date.now() + 500;
        while (Date.now() < delayUntil) { /* wait */ }
      }
    }
  }
  
  // eslint-disable-next-line no-console
  console.warn("[renderValidation] All render attempts failed, returning null");
  return null;
}

// ============================================================================
// Main Validation Function
// ============================================================================

/**
 * Unified validation function that runs all checks.
 * Designed for MCP compatibility: JSON in, JSON out.
 */
export function validateRender(input: RenderValidationInput): RenderValidationResult {
  const startTime = Date.now();
  const checksRun: string[] = [];
  
  const ldraw = input.ldraw_mpd || "";
  const mode = input.mode || "full";
  const minSimilarity = input.min_similarity ?? 60;
  const renderSize = input.render_size ?? 512;
  
  // Initialize result
  const result: RenderValidationResult = {
    valid: true,
    structure: { valid: true, issues: [] },
    continuity: { valid: true, issues: [] },
    meta: {
      duration_ms: 0,
      checks_run: [],
      ldraw_line_count: countLines(ldraw),
      ldraw_part_count: countParts(ldraw)
    }
  };
  
  // -------------------------------------------------------------------------
  // 1. Structure Validation
  // -------------------------------------------------------------------------
  checksRun.push("structure");
  
  try {
    if (mode === "chunk") {
      // Chunk mode: just check it has parts and no FILE/NOFILE wrappers
      if (ldraw.includes("0 FILE") || ldraw.includes("0 NOFILE")) {
        result.structure.issues.push({
          type: "syntax",
          severity: "error",
          message: "Chunk should not include FILE/NOFILE wrappers"
        });
      }
      if (countParts(ldraw) === 0) {
        result.structure.issues.push({
          type: "missing_parts",
          severity: "error",
          message: "Chunk contains no part placement lines"
        });
      }
      // Skip validateLDrawStructure for chunks - it checks for FILE/NOFILE
    } else if (mode === "partial") {
      validateLDrawPartialMpdOrThrow(ldraw);
      // Run structural analysis for detailed issues
      const structResult = validateLDrawStructure(ldraw);
      for (const issue of structResult.issues) {
        result.structure.issues.push({
          type: issue.type === "collision" ? "collision" : 
                issue.type === "illegal_connection" ? "continuity" : "other",
          severity: issue.severity,
          message: issue.message,
          line_number: issue.lineNumbers?.[0]
        });
      }
    } else {
      validateLDrawMpdOrThrow(ldraw);
      // Run structural analysis for detailed issues
      const structResult = validateLDrawStructure(ldraw);
      for (const issue of structResult.issues) {
        result.structure.issues.push({
          type: issue.type === "collision" ? "collision" : 
                issue.type === "illegal_connection" ? "continuity" : "other",
          severity: issue.severity,
          message: issue.message,
          line_number: issue.lineNumbers?.[0]
        });
      }
    }
  } catch (e) {
    result.structure.valid = false;
    result.structure.issues.push({
      type: "syntax",
      severity: "error",
      message: e instanceof Error ? e.message : "Structure validation failed"
    });
  }
  
  result.structure.valid = result.structure.issues.filter(i => i.severity === "error").length === 0;
  
  // -------------------------------------------------------------------------
  // 2. Continuity Checks
  // -------------------------------------------------------------------------
  checksRun.push("continuity");
  
  const continuityIssues = checkContinuity(ldraw);
  result.continuity.issues = continuityIssues;
  result.continuity.valid = continuityIssues.filter(i => i.severity === "error").length === 0;
  
  // -------------------------------------------------------------------------
  // 3. Render Progress Image (always for logging, optionally for comparison)
  // -------------------------------------------------------------------------
  const hasReferenceImage = input.reference_image_path && fs.existsSync(input.reference_image_path);
  const shouldCompare = input.do_render_comparison !== false && hasReferenceImage;
  const shouldRenderForLogging = input.always_render_for_logging === true;
  const shouldRender = shouldCompare || shouldRenderForLogging;
  
  if (shouldRender) {
    checksRun.push(shouldCompare ? "render_comparison" : "render_progress");
    
    // Create temp directory for render
    const tempDir = path.join(process.cwd(), "data", "render-validation-temp");
    const roundSuffix = input.validation_round ? `_round${input.validation_round}` : "";
    const baseName = `validate_${Date.now()}${roundSuffix}_${Math.random().toString(36).slice(2, 8)}`;
    
    // For chunk mode, we need to wrap in FILE/NOFILE for rendering
    const mpdForRender = mode === "chunk" 
      ? `0 FILE model.ldr\n${ldraw}\n0 NOFILE`
      : ldraw;
    
    const renderedPath = renderMpdToPng({
      ldrawMpd: mpdForRender,
      outputDir: tempDir,
      baseName,
      size: renderSize
    });
    
    if (renderedPath && fs.existsSync(renderedPath)) {
      result.rendered_image_path = renderedPath;
      
      // Read as base64 for MCP response
      try {
        const imageBuffer = fs.readFileSync(renderedPath);
        result.rendered_image_base64 = imageBuffer.toString("base64");
      } catch {
        // Ignore base64 encoding errors
      }
      
      // Compare to reference (only if we have a reference image)
      if (shouldCompare && input.reference_image_path) {
        try {
          const similarity = compareImages(renderedPath, input.reference_image_path);
          
          result.similarity = {
            score: similarity.overall,
            passes_threshold: similarity.overall >= minSimilarity,
            threshold: minSimilarity,
            method: similarity.details?.method || "basic",
            metrics: {
              ssim: similarity.metrics.ssim,
              mse: similarity.metrics.mse,
              psnr: similarity.metrics.psnr
            }
          };
        } catch (e) {
          result.similarity = {
            score: 0,
            passes_threshold: false,
            threshold: minSimilarity,
            method: "skipped"
          };
          result.structure.issues.push({
            type: "other",
            severity: "warning",
            message: `Image comparison failed: ${e instanceof Error ? e.message : "unknown error"}`
          });
        }
      }
    } else {
      if (shouldCompare) {
        result.similarity = {
          score: 0,
          passes_threshold: false,
          threshold: minSimilarity,
          method: "skipped"
        };
      }
      result.structure.issues.push({
        type: "other",
        severity: "warning",
        message: "Rendering failed - could not generate progress image"
      });
    }
  }
  
  // -------------------------------------------------------------------------
  // 4. Subassembly Validation (if blueprint provided)
  // -------------------------------------------------------------------------
  if (input.blueprint && input.blueprint.subassemblies && input.blueprint.subassemblies.length > 0) {
    checksRun.push("subassemblies");
    
    const subValidation = validateSubassemblies(
      ldraw, 
      input.blueprint, 
      input.current_subassembly
    );
    
    result.subassemblies = {
      checked: true,
      valid: subValidation.issues.filter(i => i.severity === "error").length === 0,
      results: subValidation.results,
      issues: subValidation.issues
    };
  }
  
  // -------------------------------------------------------------------------
  // 5. Collision Detection (if LDInspector available)
  // -------------------------------------------------------------------------
  // Note: Currently disabled due to LDInspector GUI issues on macOS
  // This section is ready for when we have a working collision detector
  result.collisions = {
    checked: false,
    valid: true,
    issues: []
  };
  
  // -------------------------------------------------------------------------
  // Determine overall validity
  // -------------------------------------------------------------------------
  const structureErrors = result.structure.issues.filter(i => i.severity === "error").length;
  const continuityErrors = result.continuity.issues.filter(i => i.severity === "error").length;
  const subassemblyErrors = result.subassemblies?.issues.filter(i => i.severity === "error").length ?? 0;
  const similarityFails = result.similarity && !result.similarity.passes_threshold;
  
  result.valid = structureErrors === 0 && continuityErrors === 0 && subassemblyErrors === 0 && !similarityFails;
  
  if (!result.valid) {
    const reasons: string[] = [];
    if (structureErrors > 0) reasons.push(`${structureErrors} structure error(s)`);
    if (continuityErrors > 0) reasons.push(`${continuityErrors} continuity error(s)`);
    if (subassemblyErrors > 0) reasons.push(`${subassemblyErrors} subassembly error(s)`);
    if (similarityFails && result.similarity) {
      reasons.push(`similarity ${result.similarity.score}% < threshold ${result.similarity.threshold}%`);
    }
    result.failure_reason = reasons.join("; ");
  }
  
  // Finalize metadata
  result.meta.duration_ms = Date.now() - startTime;
  result.meta.checks_run = checksRun;
  
  return result;
}

/** Result type for tool loop validation */
export interface ToolLoopValidationResult {
  ok: boolean;
  error?: string;
  similarity_score?: number;
  issues?: Array<{ type: string; message: string; subassembly?: string }>;
  subassembly_positions?: Array<{ name: string; position: string; valid: boolean }>;
  /** Rendered image as base64 (for visual feedback to GPT) */
  rendered_image_base64?: string;
}

/**
 * Convenience wrapper that returns a simple pass/fail with error message.
 * Suitable for use as a tool result in the OpenAI tool loop.
 * 
 * @param input - Validation input parameters
 * @param includeRenderedImage - Whether to include the rendered image base64 in the result
 */
export function validateRenderForToolLoop(
  input: RenderValidationInput,
  includeRenderedImage: boolean = false
): ToolLoopValidationResult {
  const result = validateRender(input);
  
  // Build subassembly positions (used in both success and failure cases)
  const subPositions = result.subassemblies?.results
    .filter(s => s.position)
    .map(s => ({
      name: s.name,
      position: s.position!.relative_to_model,
      valid: s.position!.attachment_valid
    }));
  
  // Base result object
  const baseResult: ToolLoopValidationResult = {
    ok: result.valid,
    similarity_score: result.similarity?.score,
    subassembly_positions: subPositions && subPositions.length > 0 ? subPositions : undefined,
    // Include rendered image if requested and available
    rendered_image_base64: includeRenderedImage ? result.rendered_image_base64 : undefined
  };
  
  if (result.valid) {
    return baseResult;
  }
  
  // Collect all issues for the error response
  const allIssues: Array<{ type: string; message: string; subassembly?: string }> = [];
  
  for (const issue of result.structure.issues) {
    if (issue.severity === "error") {
      allIssues.push({ type: issue.type, message: issue.message });
    }
  }
  
  for (const issue of result.continuity.issues) {
    if (issue.severity === "error") {
      allIssues.push({ type: issue.type, message: issue.message });
    }
  }
  
  // Include subassembly-specific issues
  if (result.subassemblies) {
    for (const subResult of result.subassemblies.results) {
      for (const issue of subResult.issues) {
        if (issue.severity === "error") {
          allIssues.push({ 
            type: issue.type, 
            message: issue.message,
            subassembly: subResult.name
          });
        }
      }
    }
  }
  
  if (result.similarity && !result.similarity.passes_threshold) {
    allIssues.push({
      type: "similarity",
      message: `Rendered image similarity (${result.similarity.score}%) is below threshold (${result.similarity.threshold}%)`
    });
  }
  
  return {
    ...baseResult,
    ok: false,
    error: result.failure_reason,
    issues: allIssues
  };
}

// ============================================================================
// Incremental Semantic Validation (for use during build)
// ============================================================================

/**
 * Run incremental semantic validation on a partial build.
 * 
 * This can be called during MPD chunk generation to validate submodules
 * without needing the reference image or complete model.
 * 
 * @param renderedImagePath - Path to rendered partial image
 * @param subassemblyInfo - Blueprint info about current subassembly
 * @param stepsCompleted - Blueprint steps completed so far
 * @returns Semantic validation result for the submodule
 */
export async function validateSubmoduleIncremental(
  renderedImagePath: string,
  subassemblyInfo: BlueprintSubassembly,
  stepsCompleted: Array<{ step: number; title: string; description: string }> = []
): Promise<{
  valid: boolean;
  confidence: number;
  progressAssessment: string;
  issues: StructureIssue[];
  summary: string;
}> {
  if (!isSemanticValidationAvailable()) {
    return {
      valid: true, // Skip if not available
      confidence: 0,
      progressAssessment: "unknown",
      issues: [{
        type: "other",
        severity: "warning",
        message: "Semantic validation not available (OpenAI API not configured)"
      }],
      summary: "Skipped - semantic validation not available"
    };
  }
  
  if (!fs.existsSync(renderedImagePath)) {
    return {
      valid: true,
      confidence: 0,
      progressAssessment: "unknown",
      issues: [{
        type: "other",
        severity: "warning",
        message: "Rendered image not found for semantic validation"
      }],
      summary: "Skipped - rendered image not found"
    };
  }
  
  try {
    const result = await validateSubmoduleSemantic(
      renderedImagePath,
      {
        name: subassemblyInfo.name,
        description: subassemblyInfo.description,
        expected_components: [], // Could be extracted from blueprint
        expected_position: subassemblyInfo.expected_position,
        symmetric: subassemblyInfo.symmetric
      },
      stepsCompleted.map(s => ({
        step: s.step,
        title: s.title,
        description: s.description
      }))
    );
    
    const issues: StructureIssue[] = result.issues.map(i => ({
      type: i.type === "missing_component" ? "missing_parts" : "other",
      severity: i.severity,
      message: `${i.component ? `[${i.component}] ` : ""}${i.type}`
    }));
    
    // Add structure issues
    if (!result.structure.matchesDescription) {
      issues.push({
        type: "other",
        severity: "warning",
        message: `Structure doesn't match description: ${result.structure.issues.join(", ")}`
      });
    }
    
    // Add symmetry issues
    if (result.symmetry.checked && !result.symmetry.symmetric) {
      issues.push({
        type: "continuity",
        severity: "warning",
        message: `Symmetry issues: ${result.symmetry.issues.join(", ")}`
      });
    }
    
    // Add build quality issues
    if (!result.buildQuality.connectionsValid) {
      issues.push({
        type: "continuity",
        severity: "error",
        message: `Build quality issues: ${result.buildQuality.issues.join(", ")}`
      });
    }
    
    return {
      valid: result.isValid,
      confidence: result.confidenceScore,
      progressAssessment: result.progressAssessment,
      issues,
      summary: result.summary
    };
  } catch (e) {
    return {
      valid: true, // Don't fail the build on semantic validation errors
      confidence: 0,
      progressAssessment: "unknown",
      issues: [{
        type: "other",
        severity: "warning",
        message: `Semantic validation error: ${e instanceof Error ? e.message : String(e)}`
      }],
      summary: "Error during semantic validation"
    };
  }
}

/**
 * Run final semantic validation on a complete model.
 * 
 * This should only be called when the model is complete and we have
 * both the reference image and the full rendered model.
 * 
 * @param referenceImagePath - Path to original reference image
 * @param renderedImagePath - Path to rendered complete model
 * @param blueprint - Full blueprint with subassemblies
 * @returns Comprehensive semantic validation result
 */
export async function validateFinalSemantic(
  referenceImagePath: string,
  renderedImagePath: string,
  blueprint: BlueprintInfo
): Promise<{
  valid: boolean;
  overallScore: number;
  referenceMatchScore: number;
  blueprintComplianceScore: number;
  issues: StructureIssue[];
  summary: string;
}> {
  if (!isSemanticValidationAvailable()) {
    return {
      valid: true,
      overallScore: 0,
      referenceMatchScore: 0,
      blueprintComplianceScore: 0,
      issues: [{
        type: "other",
        severity: "warning",
        message: "Semantic validation not available (OpenAI API not configured)"
      }],
      summary: "Skipped - semantic validation not available"
    };
  }
  
  if (!fs.existsSync(referenceImagePath) || !fs.existsSync(renderedImagePath)) {
    return {
      valid: true,
      overallScore: 0,
      referenceMatchScore: 0,
      blueprintComplianceScore: 0,
      issues: [{
        type: "other",
        severity: "warning",
        message: "Reference or rendered image not found"
      }],
      summary: "Skipped - images not found"
    };
  }
  
  try {
    const result = await validateFinalModelSemantic(
      referenceImagePath,
      renderedImagePath,
      {
        subassemblies: blueprint.subassemblies.map(s => ({
          name: s.name,
          description: s.description,
          expected_position: s.expected_position,
          symmetric: s.symmetric
        })),
        step_outline: blueprint.step_outline.map(s => ({
          step: s.step,
          title: s.title,
          description: s.description,
          subassembly: s.subassembly
        }))
      }
    );
    
    const issues: StructureIssue[] = result.issues.map(i => ({
      type: i.type === "missing_component" ? "missing_parts" : "other",
      severity: i.severity,
      message: i.description || i.type
    }));
    
    // Add reference match issues
    for (const issue of result.referenceMatch.issues) {
      issues.push({
        type: "other",
        severity: "warning",
        message: `Reference match: ${issue}`
      });
    }
    
    // Add blueprint compliance issues
    for (const sub of result.blueprintCompliance.subassembliesMissing) {
      issues.push({
        type: "missing_parts",
        severity: "error",
        message: `Missing subassembly: ${sub}`
      });
    }
    
    for (const issue of result.blueprintCompliance.positionIssues) {
      issues.push({
        type: "continuity",
        severity: "error",
        message: `Position issue: ${issue}`
      });
    }
    
    return {
      valid: result.isValid,
      overallScore: result.overallScore,
      referenceMatchScore: result.referenceMatch.score,
      blueprintComplianceScore: result.blueprintCompliance.score,
      issues,
      summary: result.summary
    };
  } catch (e) {
    return {
      valid: true,
      overallScore: 0,
      referenceMatchScore: 0,
      blueprintComplianceScore: 0,
      issues: [{
        type: "other",
        severity: "warning",
        message: `Final semantic validation error: ${e instanceof Error ? e.message : String(e)}`
      }],
      summary: "Error during final semantic validation"
    };
  }
}

// ============================================================================
// Validation Categories
// ============================================================================

/**
 * List of validations that can run incrementally (during build).
 * These do NOT require a reference image or complete model.
 */
export const INCREMENTAL_VALIDATIONS = [
  "structure_validation",      // LDraw syntax and structure (MPD-based)
  "continuity_check",          // Part alignment and connectivity (MPD-based)
  "subassembly_position",      // Position relative to partial model (MPD-based)
  "symmetry_check",            // For symmetric subassemblies (MPD-based)
  "proportion_check",          // Reasonable proportions (MPD-based)
  "submodule_semantic",        // Blueprint-based semantic check (requires render)
  "quick_component_check"      // Fast component presence check (requires render)
] as const;

/**
 * List of validations that require the complete model.
 * These need the reference image and/or full blueprint compliance.
 */
export const FINAL_ONLY_VALIDATIONS = [
  "reference_image_comparison",  // Compare render to original reference
  "full_semantic_similarity",    // Complete semantic match assessment
  "blueprint_compliance",        // All subassemblies present and positioned
  "overall_structure_match",     // Does final model match reference shape
  "final_build_quality",         // Comprehensive quality assessment
  "cross_subassembly_check",     // Connections between all subassemblies
  "image_similarity_ssim"        // Pixel-level SSIM comparison
] as const;

// ============================================================================
// MCP-Ready Export
// ============================================================================

/**
 * MCP Tool Definition (for future use)
 * 
 * This describes how the tool would be exposed via MCP.
 * The actual MCP server implementation would call validateRender().
 */
export const MCP_TOOL_DEFINITION = {
  name: "validate_ldraw_render",
  description: `Validate LDraw MPD output with comprehensive checks:
- Structure validation (syntax, FILE/NOFILE, part lines)
- Continuity checks (alignment, isolated parts, extreme coordinates)
- Image similarity comparison (renders MPD and compares to reference)
- Collision detection (when available)

Returns detailed results including similarity score and all detected issues.`,
  parameters: {
    type: "object",
    required: ["ldraw_mpd", "mode"],
    properties: {
      ldraw_mpd: {
        type: "string",
        description: "The LDraw MPD content to validate"
      },
      reference_image_path: {
        type: "string",
        description: "Path to reference PNG image for similarity comparison"
      },
      mode: {
        type: "string",
        enum: ["full", "partial", "chunk"],
        description: "Validation mode: full (complete MPD), partial (MPD so far), chunk (body-only fragment)"
      },
      step_from: {
        type: "integer",
        minimum: 1,
        description: "For chunk mode: starting blueprint step number"
      },
      step_to: {
        type: "integer",
        minimum: 1,
        description: "For chunk mode: ending blueprint step number"
      },
      min_similarity: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "Minimum similarity threshold (0-100). Default: 60"
      }
    }
  }
} as const;
