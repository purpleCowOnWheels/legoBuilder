import fs from "node:fs";
import path from "node:path";
import { spawnSync, execSync } from "node:child_process";
import { countLDrawSteps } from "@/lib/ldraw";

// ============================================================================
// LPub3D Execution Configuration
// ============================================================================

export interface LPub3DExecOptions {
  /** Command-line arguments */
  args: string[];
  /** Working directory */
  cwd?: string;
  /** Timeout in milliseconds (default: 60000) */
  timeoutMs?: number;
  /** Number of retry attempts (default: 2) */
  maxRetries?: number;
  /** Delay between retries in milliseconds (default: 1000) */
  retryDelayMs?: number;
  /** Context string for error messages */
  context?: string;
  /** Whether to kill orphaned LPub3D processes before running (default: false) */
  killOrphans?: boolean;
}

export interface LPub3DExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  error?: LPub3DError;
  attempts: number;
  totalDurationMs: number;
}

export type LPub3DErrorType = 
  | "timeout"
  | "crash"
  | "signal_killed"
  | "missing_parts"
  | "exit_error"
  | "not_found"
  | "unknown";

export interface LPub3DError {
  type: LPub3DErrorType;
  message: string;
  exitCode?: number | null;
  signal?: string | null;
  output?: string;
}

// Track concurrent renders to prevent memory exhaustion
let activeRenderCount = 0;
const MAX_CONCURRENT_RENDERS = parseInt(process.env.LPUB3D_MAX_CONCURRENT || "2", 10);

// ============================================================================
// Helper Functions
// ============================================================================

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function getLPub3DBin() {
  return process.env.LPUB3D_BIN || "/Applications/LPub3D.app/Contents/MacOS/LPub3D";
}

export function isLPub3DAvailable(): boolean {
  return fs.existsSync(getLPub3DBin());
}

function assertLPub3DAvailable() {
  const bin = getLPub3DBin();
  if (!fs.existsSync(bin)) {
    throw new Error(
      `LPub3D binary not found at ${bin}. Install LPub3D to /Applications or set LPUB3D_BIN to the executable path.`
    );
  }
  return bin;
}

function safeBaseName(base: string) {
  return base.replaceAll(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

/**
 * Kill orphaned LPub3D processes that may be hanging
 * This helps recover from previous crashes
 */
export function killOrphanedLPub3DProcesses(): { killed: number; pids: number[] } {
  const killed: number[] = [];
  
  try {
    // Find LPub3D processes (macOS/Linux)
    const psOutput = execSync("ps aux | grep -i lpub3d | grep -v grep", {
      encoding: "utf8",
      timeout: 5000
    }).trim();
    
    if (!psOutput) return { killed: 0, pids: [] };
    
    const lines = psOutput.split("\n").filter(Boolean);
    for (const line of lines) {
      const parts = line.split(/\s+/);
      const pid = parseInt(parts[1], 10);
      if (!isNaN(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
          killed.push(pid);
          // eslint-disable-next-line no-console
          console.warn(`[lpub3d] Killed orphaned process PID ${pid}`);
        } catch {
          // Process may have already exited
        }
      }
    }
  } catch {
    // ps command failed or no processes found - that's fine
  }
  
  return { killed: killed.length, pids: killed };
}

/**
 * Categorize LPub3D execution errors for better handling
 */
function categorizeError(params: {
  error?: Error;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  context: string;
}): LPub3DError {
  const { error, exitCode, signal, stdout, stderr, timedOut, context } = params;
  const output = [stdout, stderr].filter(Boolean).join("\n").slice(0, 3000);
  
  // Timeout
  if (timedOut || (error && (error as any).code === "ETIMEDOUT")) {
    return {
      type: "timeout",
      message: `LPub3D ${context} timed out. The model may be too complex or LPub3D may have hung.`,
      output
    };
  }
  
  // Killed by signal (crash)
  if (signal) {
    const crashSignals = ["SIGSEGV", "SIGBUS", "SIGABRT", "SIGILL"];
    const isCrash = crashSignals.includes(signal);
    return {
      type: isCrash ? "crash" : "signal_killed",
      message: `LPub3D ${context} was ${isCrash ? "crashed" : "killed"} by signal ${signal}.`,
      signal,
      output
    };
  }
  
  // Check for missing parts in output
  const missingPartsPattern = /(could not (open|locate)|file not found|missing (part|file)|cannot find (part|file))/i;
  if (missingPartsPattern.test(output)) {
    return {
      type: "missing_parts",
      message: `LPub3D ${context} reported missing parts/files.`,
      exitCode,
      output
    };
  }
  
  // Non-zero exit code
  if (exitCode !== null && exitCode !== 0) {
    // Check for common error patterns
    const memoryPattern = /(out of memory|memory allocation|cannot allocate)/i;
    if (memoryPattern.test(output)) {
      return {
        type: "crash",
        message: `LPub3D ${context} ran out of memory (exit code ${exitCode}).`,
        exitCode,
        output
      };
    }
    
    return {
      type: "exit_error",
      message: `LPub3D ${context} failed with exit code ${exitCode}.`,
      exitCode,
      output
    };
  }
  
  // Generic error
  return {
    type: "unknown",
    message: `LPub3D ${context} failed: ${error?.message || "unknown error"}`,
    output
  };
}

/**
 * Diagnostic hints based on crash type - helps GPT understand what might be wrong with the model
 */
export interface RenderDiagnostic {
  errorType: LPub3DErrorType;
  severity: "error" | "warning";
  message: string;
  likelyCauses: string[];
  suggestedFixes: string[];
}

/**
 * Convert a render failure into actionable diagnostic feedback for GPT
 */
export function diagnoseRenderFailure(error: LPub3DError, ldrawMpd?: string): RenderDiagnostic {
  const partCount = ldrawMpd ? (ldrawMpd.match(/^1\s+/gm) || []).length : 0;
  const stepCount = ldrawMpd ? (ldrawMpd.match(/^\s*0\s+STEP/gm) || []).length : 0;
  
  // Analyze the LDraw for potential issues
  const hasExtremeCoords = ldrawMpd ? /\b\d{6,}\b/.test(ldrawMpd) : false;
  const hasNaN = ldrawMpd ? /\bNaN\b/i.test(ldrawMpd) : false;
  const hasInfinity = ldrawMpd ? /\bInfinity\b/i.test(ldrawMpd) : false;
  
  switch (error.type) {
    case "timeout":
      return {
        errorType: "timeout",
        severity: "error",
        message: `Render timed out after retries. Model may be too complex to render.`,
        likelyCauses: [
          partCount > 500 ? `Model has ${partCount} parts - may be too complex` : null,
          stepCount > 50 ? `Model has ${stepCount} steps - rendering all steps may be slow` : null,
          "Possible infinite loop in subfile references",
          "Model geometry may be causing excessive ray tracing",
        ].filter(Boolean) as string[],
        suggestedFixes: [
          "Reduce the number of parts in the model",
          "Simplify complex geometry",
          "Check for recursive or circular subfile references",
          "Use fewer small detail parts",
        ]
      };
      
    case "crash":
      return {
        errorType: "crash",
        severity: "error",
        message: `Renderer crashed${error.signal ? ` (${error.signal})` : ""}. The model likely contains invalid data.`,
        likelyCauses: [
          hasExtremeCoords ? "DETECTED: Extreme coordinate values (>100000) in part placement" : null,
          hasNaN ? "DETECTED: NaN values in coordinates or matrix" : null,
          hasInfinity ? "DETECTED: Infinity values in coordinates" : null,
          error.signal === "SIGSEGV" ? "Memory access violation - likely invalid matrix or coordinate values" : null,
          error.signal === "SIGBUS" ? "Bus error - possibly misaligned data or corrupt values" : null,
          "Invalid transformation matrix values",
          "Coordinates outside renderable range",
          "Malformed part reference lines",
        ].filter(Boolean) as string[],
        suggestedFixes: [
          "Check all coordinates are within reasonable range (-10000 to 10000)",
          "Verify transformation matrices have valid numbers (no NaN, no Infinity)",
          "Ensure all part IDs are valid LDraw part numbers",
          "Check that rotation matrix values are between -1 and 1 for rotation components",
        ]
      };
      
    case "missing_parts":
      // Try to extract specific missing part IDs from the output
      const missingPartMatches = error.output?.match(/(?:cannot find|missing|not found)[^\n]*?(\d{3,}[a-z]?\.dat)/gi) || [];
      const missingParts = [...new Set(missingPartMatches.map(m => {
        const match = m.match(/(\d{3,}[a-z]?\.dat)/i);
        return match ? match[1] : null;
      }).filter(Boolean))];
      
      return {
        errorType: "missing_parts",
        severity: "error",
        message: `Renderer could not find required parts.${missingParts.length > 0 ? ` Missing: ${missingParts.slice(0, 5).join(", ")}` : ""}`,
        likelyCauses: [
          missingParts.length > 0 ? `Referenced non-existent parts: ${missingParts.slice(0, 5).join(", ")}` : null,
          "Part IDs may be incorrect or unofficial",
          "Using parts not in the standard LDraw library",
        ].filter(Boolean) as string[],
        suggestedFixes: [
          "Verify all part numbers against the inventory provided",
          "Use only official LDraw part numbers (check rebrickable for correct IDs)",
          "Replace unofficial parts with similar official alternatives",
          missingParts.length > 0 ? `Specifically fix or replace: ${missingParts.slice(0, 3).join(", ")}` : null,
        ].filter(Boolean) as string[]
      };
      
    case "exit_error":
      return {
        errorType: "exit_error",
        severity: "error",
        message: `Renderer exited with error code ${error.exitCode}.`,
        likelyCauses: [
          "Malformed LDraw syntax",
          "Invalid color codes",
          "Corrupt or incomplete FILE/NOFILE structure",
        ],
        suggestedFixes: [
          "Check LDraw syntax matches the specification",
          "Ensure all color codes are valid (0-511 range)",
          "Verify FILE and NOFILE blocks are properly matched",
        ]
      };
      
    case "signal_killed":
      return {
        errorType: "signal_killed",
        severity: "warning",
        message: `Renderer was terminated by system (${error.signal}).`,
        likelyCauses: [
          "System resource limits exceeded",
          "Process was manually killed",
          "System under memory pressure",
        ],
        suggestedFixes: [
          "Try rendering again - may be transient",
          "Reduce model complexity if retries fail",
        ]
      };
      
    default:
      return {
        errorType: "unknown",
        severity: "error",
        message: error.message,
        likelyCauses: ["Unknown render failure"],
        suggestedFixes: ["Check LDraw syntax and try again"]
      };
  }
}

/**
 * Wait for concurrent render slot
 */
async function waitForRenderSlot(timeoutMs: number = 30000): Promise<boolean> {
  const startTime = Date.now();
  while (activeRenderCount >= MAX_CONCURRENT_RENDERS) {
    if (Date.now() - startTime > timeoutMs) {
      return false;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  activeRenderCount++;
  return true;
}

function releaseRenderSlot() {
  activeRenderCount = Math.max(0, activeRenderCount - 1);
}

/**
 * Execute LPub3D with retry logic and crash handling
 */
export function executeLPub3D(options: LPub3DExecOptions): LPub3DExecResult {
  const bin = getLPub3DBin();
  const maxRetries = options.maxRetries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 60000;
  const context = options.context ?? "operation";
  
  // Check binary exists
  if (!fs.existsSync(bin)) {
    return {
      success: false,
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      error: {
        type: "not_found",
        message: `LPub3D binary not found at ${bin}`
      },
      attempts: 0,
      totalDurationMs: 0
    };
  }
  
  // Kill orphans if requested
  if (options.killOrphans) {
    killOrphanedLPub3DProcesses();
  }
  
  const startTime = Date.now();
  let lastStdout = "";
  let lastStderr = "";
  let lastStatus: number | null = null;
  let lastSignal: NodeJS.Signals | null = null;
  let lastError: Error | null = null;
  let attempts = 0;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt + 1;
    
    // Add delay between retries
    if (attempt > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[lpub3d] Retry ${attempt}/${maxRetries} for ${context} after ${retryDelayMs}ms delay`);
      
      // Kill any hanging processes before retry
      killOrphanedLPub3DProcesses();
      
      // Synchronous delay
      const delayUntil = Date.now() + retryDelayMs;
      while (Date.now() < delayUntil) {
        // Busy wait (not ideal but works for sync context)
      }
    }
    
    try {
      const result = spawnSync(bin, options.args, {
        encoding: "utf8",
        timeout: timeoutMs,
        cwd: options.cwd,
        // Prevent LPub3D from trying to open GUI dialogs
        env: {
          ...process.env,
          QT_QPA_PLATFORM: "offscreen",
          DISPLAY: process.env.DISPLAY || ""
        }
      });
      
      // Extract results with proper type handling
      lastStdout = typeof result.stdout === "string" ? result.stdout : "";
      lastStderr = typeof result.stderr === "string" ? result.stderr : "";
      lastStatus = result.status;
      lastSignal = result.signal;
      lastError = result.error || null;
      
      const timedOut = !!result.error && (result.error as any).code === "ETIMEDOUT";
      
      // Success case: no error, exit code 0, no crash signals
      if (!result.error && result.status === 0 && !result.signal) {
        return {
          success: true,
          stdout: lastStdout,
          stderr: lastStderr,
          exitCode: 0,
          signal: null,
          attempts,
          totalDurationMs: Date.now() - startTime
        };
      }
      
      // Check if this is a retryable error
      const error = categorizeError({
        error: result.error || undefined,
        exitCode: result.status,
        signal: result.signal,
        stdout: lastStdout,
        stderr: lastStderr,
        timedOut,
        context
      });
      
      // Don't retry for missing parts - that won't be fixed by retrying
      if (error.type === "missing_parts") {
        return {
          success: false,
          stdout: lastStdout,
          stderr: lastStderr,
          exitCode: result.status,
          signal: result.signal,
          error,
          attempts,
          totalDurationMs: Date.now() - startTime
        };
      }
      
      // Continue retrying for other errors
      lastError = result.error || new Error(error.message);
      
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  
  // All retries exhausted
  const error = categorizeError({
    error: lastError || undefined,
    exitCode: lastStatus,
    signal: lastSignal,
    stdout: lastStdout,
    stderr: lastStderr,
    timedOut: lastError?.message?.includes("ETIMEDOUT") ?? false,
    context
  });
  
  return {
    success: false,
    stdout: lastStdout,
    stderr: lastStderr,
    exitCode: lastStatus,
    signal: lastSignal,
    error,
    attempts,
    totalDurationMs: Date.now() - startTime
  };
}

/**
 * Execute LPub3D with concurrency limiting (async wrapper)
 */
export async function executeLPub3DAsync(options: LPub3DExecOptions): Promise<LPub3DExecResult> {
  // Wait for a render slot
  const gotSlot = await waitForRenderSlot(options.timeoutMs ?? 60000);
  if (!gotSlot) {
    return {
      success: false,
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      error: {
        type: "timeout",
        message: `Timed out waiting for render slot (max concurrent: ${MAX_CONCURRENT_RENDERS})`
      },
      attempts: 0,
      totalDurationMs: 0
    };
  }
  
  try {
    return executeLPub3D(options);
  } finally {
    releaseRenderSlot();
  }
}

function assertNoLPub3DWarnings(output: string, context: string) {
  const o = output || "";
  // Keep this conservative: only fail on strong signals that parts/files are missing.
  const bad = /(could not (open|locate)|file not found|missing (part|file)|cannot find (part|file))/i;
  if (bad.test(o)) {
    throw new Error(`LPub3D reported missing parts/files during ${context}. Output:\n${o.slice(0, 3000)}`);
  }
}

export function writeIdeaMpdToDisk(params: { baseName: string; ldrawMpd: string }) {
  const dir = path.join(process.cwd(), "data", "ldraw");
  ensureDir(dir);
  const base = safeBaseName(params.baseName);
  const mpdPath = path.join(dir, `${base}.mpd`);
  fs.writeFileSync(mpdPath, params.ldrawMpd, "utf8");
  return mpdPath;
}

export function generateThumbnailPngFromMpd(params: { 
  mpdPath: string; 
  baseName: string; 
  size?: number;
  timeoutMs?: number;
  maxRetries?: number;
}) {
  assertLPub3DAvailable();
  const outDir = path.join(process.cwd(), "public", "generated-thumbs");
  ensureDir(outDir);

  const base = safeBaseName(params.baseName);
  const outPath = path.join(outDir, `${base}.png`);

  const raw = fs.readFileSync(params.mpdPath, "utf8");
  const stepCount = countLDrawSteps(raw);
  const size = params.size ?? 1024;

  const args = [
    "--liblego",
    "-i",
    outPath,
    "-w",
    String(size),
    "-h",
    String(size),
    "--from",
    String(stepCount),
    "--to",
    String(stepCount),
    "--viewpoint",
    "home",
    params.mpdPath
  ];

  const result = executeLPub3D({
    args,
    context: "thumbnail generation",
    timeoutMs: params.timeoutMs ?? 60000,
    maxRetries: params.maxRetries ?? 2,
    killOrphans: true
  });
  
  if (!result.success) {
    const errorMsg = result.error?.message || "Unknown error";
    const errorType = result.error?.type || "unknown";
    throw new Error(`LPub3D thumbnail generation failed (${errorType}, ${result.attempts} attempts): ${errorMsg}`);
  }
  
  assertNoLPub3DWarnings([result.stdout, result.stderr].filter(Boolean).join("\n"), "thumbnail render");
  
  if (!fs.existsSync(outPath)) {
    throw new Error("LPub3D thumbnail generation succeeded but output PNG was not created.");
  }

  return { url: `/generated-thumbs/${path.basename(outPath)}`, outPath };
}

export function generateInstructionsPdfFromMpd(params: { 
  mpdPath: string; 
  baseName: string; 
  timeoutMs?: number;
  maxRetries?: number;
}) {
  assertLPub3DAvailable();
  const outDir = path.join(process.cwd(), "public", "generated-instructions");
  ensureDir(outDir);

  const base = safeBaseName(params.baseName);
  const outPath = path.join(outDir, `${base}.pdf`);

  const args = ["--process-export", "--export-option", "pdf", "--output-file", outPath, "--liblego", params.mpdPath];
  const timeoutMs = params.timeoutMs || 120000; // 2 minutes default
  
  const result = executeLPub3D({
    args,
    context: "PDF export",
    timeoutMs,
    maxRetries: params.maxRetries ?? 2,
    killOrphans: true
  });
  
  if (!result.success) {
    const errorMsg = result.error?.message || "Unknown error";
    const errorType = result.error?.type || "unknown";
    throw new Error(`LPub3D PDF export failed (${errorType}, ${result.attempts} attempts): ${errorMsg}`);
  }
  
  assertNoLPub3DWarnings([result.stdout, result.stderr].filter(Boolean).join("\n"), "pdf export");
  
  if (!fs.existsSync(outPath)) {
    throw new Error("LPub3D PDF export succeeded but output PDF was not created.");
  }

  return { url: `/generated-instructions/${path.basename(outPath)}`, outPath };
}


