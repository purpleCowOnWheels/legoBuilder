import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ConnectionValidationResult {
  isValid: boolean;
  connections: Array<{
    upper_part: string;
    lower_part: string;
    strength: number;
  }>;
  issues: Array<{
    type: string;
    severity: "error" | "warning";
    message: string;
    part_ids: string[];
    details: Record<string, any>;
  }>;
  stats: {
    total_parts: number;
    supported_parts: number;
    connections: number;
    errors: number;
    warnings: number;
  };
}

export interface ConnectionAutoFixResult {
  isValid: boolean;
  autoCorrected: boolean;
  iterations: number;
  fixesApplied: number;
  fixesSummary: string[];
  correctedContent: string;
  originalErrors: number;
  finalErrors: number;
  stats: {
    total_parts: number;
    supported_parts: number;
    connections: number;
    errors: number;
    warnings: number;
  };
  remainingIssues: Array<{
    type: string;
    severity: string;
    message: string;
  }>;
}

/**
 * Validate LEGO part connections in an MPD file.
 * 
 * Checks for:
 * - Floating parts (no connections below)
 * - Invalid rotations (not 90° increments)
 * - Off-grid positioning
 * - Proper stud-to-tube alignment
 * 
 * Note: Only validates basic LEGO parts (bricks, plates, tiles).
 * Special parts (Technic, hinges, etc.) are not yet supported.
 * 
 * @param mpdPath - Path to the MPD file to validate
 * @returns Validation result with connections and issues
 */
export function validateLegoConnections(mpdPath: string): ConnectionValidationResult {
  const scriptPath = path.join(__dirname, "../../scripts/connection_validator/validate_connections.py");
  
  const result = spawnSync("python3", [scriptPath, mpdPath, "--json"], {
    encoding: "utf8",
    timeout: 60000, // 60 seconds
    maxBuffer: 10 * 1024 * 1024 // 10MB
  });

  if (result.error) {
    throw new Error(`Connection validation failed: ${result.error.message}`);
  }

  if (result.status === 2) {
    // Script error (not validation failure)
    throw new Error(`Connection validator error: ${result.stderr}`);
  }

  try {
    const data = JSON.parse(result.stdout);
    return {
      isValid: data.is_valid,
      connections: data.connections,
      issues: data.issues,
      stats: data.stats
    };
  } catch (e) {
    throw new Error(`Failed to parse validation result: ${e instanceof Error ? e.message : String(e)}\nOutput: ${result.stdout}`);
  }
}

/**
 * Quick check if connection validation is available (Python + numpy installed).
 */
export function isConnectionValidationAvailable(): boolean {
  try {
    const result = spawnSync("python3", ["-c", "import numpy; print('ok')"], {
      encoding: "utf8",
      timeout: 5000
    });
    return result.status === 0 && result.stdout?.includes("ok");
  } catch {
    return false;
  }
}

/**
 * Auto-fix LEGO part connections in an MPD file.
 * 
 * Automatically adjusts positions of floating parts to connect properly.
 * Iterates until all fixable issues are resolved or max iterations reached.
 * 
 * @param mpdPath - Path to the MPD file to validate and fix
 * @param maxIterations - Maximum fix iterations (default 50)
 * @returns Result with corrected content and fix summary
 */
export function autoFixLegoConnections(mpdPath: string, maxIterations: number = 50): ConnectionAutoFixResult {
  const scriptPath = path.join(__dirname, "../../scripts/connection_validator/validate_connections.py");
  
  const result = spawnSync("python3", [
    scriptPath, 
    mpdPath, 
    "--auto-fix", 
    "--json",
    "--max-iterations", 
    String(maxIterations)
  ], {
    encoding: "utf8",
    timeout: 120000, // 2 minutes for iterative fixing
    maxBuffer: 50 * 1024 * 1024 // 50MB for large corrected content
  });

  if (result.error) {
    throw new Error(`Connection auto-fix failed: ${result.error.message}`);
  }

  if (result.status === 2) {
    // Script error (not validation failure)
    throw new Error(`Connection auto-fix error: ${result.stderr}`);
  }

  try {
    const data = JSON.parse(result.stdout);
    return {
      isValid: data.is_valid,
      autoCorrected: data.auto_corrected,
      iterations: data.iterations,
      fixesApplied: data.fixes_applied,
      fixesSummary: data.fixes_summary || [],
      correctedContent: data.corrected_content,
      originalErrors: data.original_errors,
      finalErrors: data.final_errors,
      stats: data.stats,
      remainingIssues: data.remaining_issues || []
    };
  } catch (e) {
    throw new Error(`Failed to parse auto-fix result: ${e instanceof Error ? e.message : String(e)}\nOutput: ${result.stdout}`);
  }
}
