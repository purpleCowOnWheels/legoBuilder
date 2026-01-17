import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Existing validation functions...
export function validateLDrawMpdOrThrow(ldrawMpd: string) {
  if (typeof ldrawMpd !== "string" || ldrawMpd.trim().length === 0) {
    throw new Error("LDraw MPD is empty");
  }
  if (!ldrawMpd.includes("0 FILE")) {
    throw new Error("LDraw MPD must include at least one `0 FILE` section");
  }
  if (!ldrawMpd.includes("0 NOFILE")) {
    throw new Error("LDraw MPD must end with `0 NOFILE`");
  }
  if (ldrawMpd.includes("```")) {
    throw new Error("LDraw MPD contains code fences (```), which breaks parsing");
  }

  const lines = ldrawMpd.split(/\r?\n/);
  const partLines = lines.filter((line) => {
    const t = line.trim();
    if (!t || t.startsWith("0 ") || t.startsWith("0\t")) return false;
    return /^1\s+/.test(t);
  });
  if (partLines.length === 0) {
    throw new Error("LDraw MPD contains no part placement lines (type 1)");
  }
}

export function validateLDrawPartialMpdOrThrow(ldrawMpd: string) {
  if (typeof ldrawMpd !== "string" || ldrawMpd.trim().length === 0) {
    throw new Error("LDraw partial MPD is empty");
  }
  if (!ldrawMpd.includes("0 FILE")) {
    throw new Error("LDraw partial MPD must include at least one `0 FILE` section");
  }
  if (!ldrawMpd.includes("0 NOFILE")) {
    throw new Error("LDraw partial MPD must end with `0 NOFILE`");
  }
  if (ldrawMpd.includes("```")) {
    throw new Error("LDraw partial MPD contains code fences (```), which breaks parsing");
  }

  const lines = ldrawMpd.split(/\r?\n/);
  const partLines = lines.filter((line) => {
    const t = line.trim();
    if (!t || t.startsWith("0 ") || t.startsWith("0\t")) return false;
    return /^1\s+/.test(t);
  });
  if (partLines.length === 0) {
    throw new Error("LDraw partial MPD contains no part placement lines (type 1)");
  }
}

export function validateLDrawMpdChunkBodyOrThrow(params: {
  chunkBody: string;
  stepFrom?: number;
  stepTo?: number;
}) {
  const raw = params.chunkBody ?? "";
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("LDraw chunk is empty");
  }
  if (raw.includes("```")) {
    throw new Error("LDraw chunk contains code fences (```), which breaks parsing");
  }

  // Chunks must be BODY-ONLY (no FILE/NOFILE wrappers).
  if (/^\s*0\s+FILE\b/im.test(raw)) {
    throw new Error("LDraw chunk must not include `0 FILE` (expected body-only chunk)");
  }
  if (/^\s*0\s+NOFILE\s*$/im.test(raw)) {
    throw new Error("LDraw chunk must not include `0 NOFILE` (expected body-only chunk)");
  }

  const lines = raw.split(/\r?\n/);
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const partLines = nonEmpty.filter((l) => /^1\s+/.test(l.trim()));
  if (partLines.length === 0) {
    throw new Error("LDraw chunk contains no part placement lines (type 1)");
  }

  // If this chunk spans multiple blueprint steps (stepFrom < stepTo), require at least one `0 STEP` delimiter.
  // If it's a single step (stepFrom === stepTo or undefined), we allow 0 or more `0 STEP` lines.
  const stepFrom = params.stepFrom ?? 0;
  const stepTo = params.stepTo ?? 0;
  const isMultiStep = stepTo > stepFrom;

  if (isMultiStep) {
    const stepMatches = raw.match(/^\s*0\s+STEP\s*$/gim);
    const stepCount = stepMatches ? stepMatches.length : 0;
    if (stepCount === 0) {
      throw new Error("LDraw chunk spanning multiple steps must include at least one `0 STEP` delimiter");
    }
  }
}

// ============================================================================
// NEW: Advanced Validation with LDInspector (collision detection)
// ============================================================================

export interface LDInspectorIssue {
  type: "collision" | "illegal_connection" | "discontinuity" | "other";
  severity: "error" | "warning";
  message: string;
  partIds?: string[];
  lineNumbers?: number[];
}

export interface LDInspectorResult {
  isValid: boolean;
  issues: LDInspectorIssue[];
  rawOutput?: string;
}

/**
 * Run LDInspector collision checker on an MPD file.
 * 
 * Uses the CLI tool: ldinsp.tools.LDITFileCheckerCollision
 * 
 * Installation:
 * - Java 17 required
 * - LDInspector JAR downloaded
 * - Wrapper script: /Users/dan.costanza/Applications/LDInspector/ldinspector-collision
 * 
 * Set LDINSPECTOR_BIN environment variable to override the default path.
 * 
 * @param mpdPath - Path to the MPD file to validate
 * @param options - Validation options
 * @returns Validation result with detected collisions
 */
export function runLDInspector(
  mpdPath: string,
  options: {
    checkCollisions?: boolean;
    checkConnections?: boolean;
    timeout?: number; // milliseconds
  } = {}
): LDInspectorResult {
  const {
    timeout = 30000
  } = options;

  // Find LDInspector binary
  const ldInspectorBin = findLDInspectorBinary();
  if (!ldInspectorBin) {
    console.warn("LDInspector not found. Skipping collision detection.");
    console.warn("Install from: https://fam-frenz.de/stefan/ldi.html");
    console.warn("Wrapper script: /Users/dan.costanza/Applications/LDInspector/ldinspector-collision");
    return {
      isValid: true,
      issues: [],
      rawOutput: "LDInspector not available"
    };
  }

  if (!fs.existsSync(mpdPath)) {
    throw new Error(`MPD file not found: ${mpdPath}`);
  }

  try {
    // Run the collision checker
    const result = spawnSync(ldInspectorBin, [mpdPath], {
      encoding: "utf8",
      timeout,
      maxBuffer: 10 * 1024 * 1024 // 10MB
    });

    if (result.error) {
      throw result.error;
    }

    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const issues = parseLDInspectorOutput(output);

    return {
      isValid: issues.filter(i => i.severity === "error").length === 0,
      issues,
      rawOutput: output
    };

  } catch (error) {
    console.error("LDInspector execution failed:", error);
    return {
      isValid: false,
      issues: [{
        type: "other",
        severity: "error",
        message: `LDInspector execution failed: ${error instanceof Error ? error.message : String(error)}`
      }],
      rawOutput: error instanceof Error ? error.message : String(error)
    };
  }
}

function findLDInspectorBinary(): string | null {
  // Check environment variable first
  if (process.env.LDINSPECTOR_BIN) {
    if (fs.existsSync(process.env.LDINSPECTOR_BIN)) {
      return process.env.LDINSPECTOR_BIN;
    }
  }

  // Check default installation location
  const defaultPath = "/Users/dan.costanza/Applications/LDInspector/ldinspector-collision";
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }

  return null;
}

function parseLDInspectorOutput(output: string): LDInspectorIssue[] {
  const issues: LDInspectorIssue[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Parse actual LDInspector collision checker output
    // Format: "  ok : no colliding parts" or collision reports
    if (/collision|colliding/i.test(trimmed)) {
      if (/no colliding|ok/i.test(trimmed)) {
        // No collision - this is good, don't add an issue
        continue;
      } else {
        // Found collision
        issues.push({
          type: "collision",
          severity: "error",
          message: trimmed
        });
      }
    } else if (/missing/i.test(trimmed)) {
      // Part missing warning (not an error for our purposes)
      issues.push({
        type: "other",
        severity: "warning",
        message: trimmed
      });
    } else if (/error|fail/i.test(trimmed)) {
      issues.push({
        type: "other",
        severity: "error",
        message: trimmed
      });
    }
  }

  return issues;
}

/**
 * Quick heuristic validation for common issues (doesn't require external tools)
 */
export function validateLDrawStructure(ldrawMpd: string): LDInspectorResult {
  const issues: LDInspectorIssue[] = [];
  const lines = ldrawMpd.split(/\r?\n/);

  // Check for basic structure
  let hasFile = false;
  let hasNoFile = false;
  let partCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    if (line.startsWith("0 FILE")) {
      hasFile = true;
    }
    if (line.startsWith("0 NOFILE")) {
      hasNoFile = true;
    }
    if (/^1\s+/.test(line)) {
      partCount++;
      
      // Check for NaN or invalid coordinates
      const parts = line.split(/\s+/);
      if (parts.length >= 14) {
        const coords = parts.slice(2, 14);
        for (const coord of coords) {
          if (isNaN(parseFloat(coord))) {
            issues.push({
              type: "other",
              severity: "error",
              message: `Invalid coordinate at line ${i + 1}: ${line}`,
              lineNumbers: [i + 1]
            });
          }
        }
      }
    }
  }

  if (!hasFile) {
    issues.push({
      type: "other",
      severity: "error",
      message: "Missing '0 FILE' directive"
    });
  }

  if (!hasNoFile) {
    issues.push({
      type: "other",
      severity: "error",
      message: "Missing '0 NOFILE' directive"
    });
  }

  if (partCount === 0) {
    issues.push({
      type: "other",
      severity: "error",
      message: "No parts found in MPD"
    });
  }

  return {
    isValid: issues.filter(i => i.severity === "error").length === 0,
    issues
  };
}
