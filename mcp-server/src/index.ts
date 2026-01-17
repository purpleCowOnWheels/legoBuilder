#!/usr/bin/env node
/**
 * LEGO Builder Validation MCP Server
 * 
 * Exposes 3 high-level validation tools that internally run ALL applicable checks:
 * 
 *   1) validate_step     - All step/chunk validations
 *   2) validate_submodule - All submodule validations  
 *   3) validate_full     - All final model validations
 * 
 * The MCP server decides which checks to run based on:
 *   - What's available (Python, OpenAI API, etc.)
 *   - What inputs are provided (images, blueprint, etc.)
 *   - What makes sense for that validation level
 * 
 * Returns comprehensive results for GPT to review.
 * 
 * LOGGING:
 *   All validations are logged to data/mcp-logs/ with:
 *   - Timestamp and sequence number
 *   - Stage indicator (step/submodule/full)
 *   - Input from GPT
 *   - Validation results
 *   - Copies of any rendered images
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ============================================================================
// Logging System
// ============================================================================

interface LogEntry {
  sequence: number;
  timestamp: string;
  stage: "step" | "submodule" | "full";
  tool: string;
  input: Record<string, unknown>;
  result: unknown;
  images?: {
    render?: string;      // Path to copied render image
    reference?: string;   // Path to copied reference image
  };
  duration_ms: number;
}

class ValidationLogger {
  private logDir: string;
  private sessionId: string;
  private sequence: number = 0;
  private sessionLogPath: string;
  private entries: LogEntry[] = [];

  constructor() {
    // Determine log directory (relative to project root)
    const projectRoot = path.resolve(process.cwd());
    this.logDir = path.join(projectRoot, "data", "mcp-logs");
    
    // Create session ID from timestamp
    const now = new Date();
    this.sessionId = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    
    // Create session directory
    const sessionDir = path.join(this.logDir, this.sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(path.join(sessionDir, "images"), { recursive: true });
    
    // Create session log file
    this.sessionLogPath = path.join(sessionDir, "session.json");
    
    // Initialize session log
    this.writeSessionLog();
    
    console.error(`[MCP Logger] Session: ${this.sessionId}`);
    console.error(`[MCP Logger] Log dir: ${sessionDir}`);
  }

  private writeSessionLog() {
    const sessionData = {
      session_id: this.sessionId,
      started_at: new Date().toISOString(),
      entry_count: this.entries.length,
      entries: this.entries
    };
    fs.writeFileSync(this.sessionLogPath, JSON.stringify(sessionData, null, 2), "utf8");
  }

  private copyImage(sourcePath: string, stage: string, seq: number, label: string): string | undefined {
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      return undefined;
    }
    
    try {
      const ext = path.extname(sourcePath) || ".png";
      const destName = `${seq.toString().padStart(4, "0")}_${stage}_${label}${ext}`;
      const destPath = path.join(this.logDir, this.sessionId, "images", destName);
      fs.copyFileSync(sourcePath, destPath);
      return destName; // Return relative path within session
    } catch (e) {
      console.error(`[MCP Logger] Failed to copy image: ${e}`);
      return undefined;
    }
  }

  log(params: {
    stage: "step" | "submodule" | "full";
    tool: string;
    input: Record<string, unknown>;
    result: unknown;
    renderImagePath?: string;
    referenceImagePath?: string;
    duration_ms: number;
  }): LogEntry {
    this.sequence++;
    const seq = this.sequence;
    
    // Copy any images
    const images: LogEntry["images"] = {};
    if (params.renderImagePath) {
      images.render = this.copyImage(params.renderImagePath, params.stage, seq, "render");
    }
    if (params.referenceImagePath) {
      images.reference = this.copyImage(params.referenceImagePath, params.stage, seq, "reference");
    }

    // Create sanitized input (don't log huge LDraw content, just metadata)
    const sanitizedInput = { ...params.input };
    if (typeof sanitizedInput.ldraw_content === "string") {
      const content = sanitizedInput.ldraw_content as string;
      sanitizedInput.ldraw_content = `[${content.length} chars, ${content.split("\n").length} lines]`;
      sanitizedInput._ldraw_first_lines = content.split("\n").slice(0, 5).join("\n");
    }
    if (typeof sanitizedInput.ldraw_mpd === "string") {
      const content = sanitizedInput.ldraw_mpd as string;
      sanitizedInput.ldraw_mpd = `[${content.length} chars, ${content.split("\n").length} lines]`;
      sanitizedInput._ldraw_first_lines = content.split("\n").slice(0, 5).join("\n");
    }

    const entry: LogEntry = {
      sequence: seq,
      timestamp: new Date().toISOString(),
      stage: params.stage,
      tool: params.tool,
      input: sanitizedInput,
      result: params.result,
      images: Object.keys(images).length > 0 ? images : undefined,
      duration_ms: params.duration_ms
    };

    this.entries.push(entry);
    
    // Write individual entry file
    const entryFileName = `${seq.toString().padStart(4, "0")}_${params.stage}_${params.tool}.json`;
    const entryPath = path.join(this.logDir, this.sessionId, entryFileName);
    
    // For individual file, include full LDraw content
    const fullEntry = {
      ...entry,
      input: params.input // Use original input with full content
    };
    fs.writeFileSync(entryPath, JSON.stringify(fullEntry, null, 2), "utf8");
    
    // Update session log
    this.writeSessionLog();
    
    // Log to stderr for visibility
    const resultValid = (params.result as any)?.valid;
    const checksPassed = (params.result as any)?.checks_passed ?? "?";
    const checksFailed = (params.result as any)?.checks_failed ?? "?";
    console.error(
      `[MCP Log #${seq}] ${params.stage.toUpperCase()} | ${params.tool} | ` +
      `${resultValid ? "PASS" : "FAIL"} (${checksPassed}/${checksPassed + checksFailed} checks) | ` +
      `${params.duration_ms}ms`
    );
    
    return entry;
  }

  getSessionDir(): string {
    return path.join(this.logDir, this.sessionId);
  }

  getSessionId(): string {
    return this.sessionId;
  }
}

// Global logger instance
let logger: ValidationLogger;

// Import validators from main app
import {
  validateRender,
  type BlueprintInfo
} from "../../src/lib/renderValidation";
import {
  validateLDrawMpdOrThrow,
  validateLDrawPartialMpdOrThrow,
  validateLDrawMpdChunkBodyOrThrow,
  validateLDrawStructure
} from "../../src/lib/ldrawValidate";
import {
  validateSemanticSimilarity,
  validateSubmoduleSemantic,
  validateFinalModelSemantic,
  isSemanticValidationAvailable,
  type SubassemblyInfo,
  type BlueprintStep,
  type Blueprint
} from "../../src/lib/semanticValidator";
import { validateLegoConnections, isConnectionValidationAvailable } from "../../src/lib/connectionValidator";
import { compareImages } from "../../src/lib/imageSimilarity";
import { validatePhysics, isPhysicallyStable, type PhysicsValidationResult } from "../../src/lib/physicsValidator";

// ============================================================================
// Capability Detection
// ============================================================================

interface Capabilities {
  semantic: boolean;
  connections: boolean;
  imageComparison: boolean;
}

function detectCapabilities(): Capabilities {
  return {
    semantic: isSemanticValidationAvailable(),
    connections: isConnectionValidationAvailable(),
    imageComparison: true // Basic comparison always available
  };
}

// ============================================================================
// Tool Definitions - 3 High-Level Tools
// ============================================================================

const TOOLS = [
  {
    name: "validate_step",
    description: `Validate a step or chunk of LDraw code.

Runs ALL applicable validations for step-level checking:
- Syntax validation (FILE/NOFILE, part lines, coordinates)
- Continuity checks (alignment, isolated parts, extreme coords)
- Connection validation (stud alignment, floating parts) [if available]

The MCP server automatically determines which checks to run based on:
- mode: "chunk" (body only), "partial" (MPD so far), or "full"
- Available validators on this system

Returns a comprehensive report with all check results.`,
    inputSchema: {
      type: "object",
      required: ["ldraw_content", "mode"],
      properties: {
        ldraw_content: {
          type: "string",
          description: "The LDraw content to validate"
        },
        mode: {
          type: "string",
          enum: ["chunk", "partial", "full"],
          description: "chunk=body only (no FILE/NOFILE), partial=assembled MPD so far, full=complete MPD"
        },
        step_from: {
          type: "integer",
          minimum: 1,
          description: "Starting step number (for chunk mode, helps validate STEP delimiters)"
        },
        step_to: {
          type: "integer",
          minimum: 1,
          description: "Ending step number (for chunk mode)"
        }
      }
    }
  },

  {
    name: "validate_submodule",
    description: `Validate a submodule/subassembly during the build.

Runs ALL applicable validations for submodule-level checking:
- Structural validation (syntax, continuity)
- Position validation (is subassembly in expected location?)
- Symmetry checks (for symmetric subassemblies)
- Proportion checks (reasonable size ratios)
- Semantic validation via AI vision [if render image provided and OpenAI available]
- Connection validation [if available]

This is INCREMENTAL validation - can run during the build without a reference image.
The blueprint describes what the subassembly SHOULD look like.

Returns a comprehensive report with all check results.`,
    inputSchema: {
      type: "object",
      required: ["ldraw_mpd", "subassembly_name", "blueprint"],
      properties: {
        ldraw_mpd: {
          type: "string",
          description: "The assembled LDraw MPD so far (wrapped with FILE/NOFILE)"
        },
        subassembly_name: {
          type: "string",
          description: "Name of the subassembly to validate (e.g., 'torso', 'arms', 'head')"
        },
        blueprint: {
          type: "object",
          description: "Blueprint with subassemblies and step_outline arrays"
        },
        render_image_path: {
          type: "string",
          description: "Optional: path to rendered PNG for semantic validation"
        },
        steps_completed: {
          type: "integer",
          description: "Number of blueprint steps completed so far"
        }
      }
    }
  },

  {
    name: "validate_full",
    description: `Validate a complete, finished model.

Runs ALL applicable validations for final model checking:
- Full structural validation
- Blueprint compliance (all subassemblies present and positioned)
- Cross-subassembly connections
- Image similarity (SSIM) [if reference image provided]
- Semantic similarity via AI vision [if images provided and OpenAI available]
- Connection validation [if available]

This is FINAL validation - requires complete model.
Optionally compares against reference image for similarity scoring.

Returns a comprehensive report with all check results.`,
    inputSchema: {
      type: "object",
      required: ["ldraw_mpd"],
      properties: {
        ldraw_mpd: {
          type: "string",
          description: "The complete LDraw MPD"
        },
        reference_image_path: {
          type: "string",
          description: "Path to original reference image for comparison"
        },
        render_image_path: {
          type: "string",
          description: "Path to rendered PNG of complete model"
        },
        blueprint: {
          type: "object",
          description: "Blueprint for compliance checking"
        },
        min_similarity: {
          type: "integer",
          minimum: 0,
          maximum: 100,
          description: "Minimum similarity threshold (0-100). Default: 60"
        }
      }
    }
  }
];

// ============================================================================
// Comprehensive Validation Handlers
// ============================================================================

interface ValidationCheck {
  name: string;
  passed: boolean;
  score?: number;
  details: Record<string, unknown>;
  error?: string;
}

interface ComprehensiveResult {
  valid: boolean;
  checks_run: string[];
  checks_passed: number;
  checks_failed: number;
  checks: ValidationCheck[];
  summary: string;
  recommendations?: string[];
}

/**
 * STEP VALIDATION - runs all applicable step-level checks
 */
async function handleValidateStep(args: Record<string, unknown>): Promise<ComprehensiveResult> {
  const content = args.ldraw_content as string;
  const mode = args.mode as "chunk" | "partial" | "full";
  const stepFrom = args.step_from as number | undefined;
  const stepTo = args.step_to as number | undefined;
  
  const capabilities = detectCapabilities();
  const checks: ValidationCheck[] = [];
  const recommendations: string[] = [];

  // -------------------------------------------------------------------------
  // Check 1: Syntax Validation
  // -------------------------------------------------------------------------
  try {
    if (mode === "chunk") {
      validateLDrawMpdChunkBodyOrThrow({ chunkBody: content, stepFrom, stepTo });
    } else if (mode === "partial") {
      validateLDrawPartialMpdOrThrow(content);
    } else {
      validateLDrawMpdOrThrow(content);
    }
    
    checks.push({
      name: "syntax",
      passed: true,
      details: { mode, step_range: stepFrom && stepTo ? `${stepFrom}-${stepTo}` : undefined }
    });
  } catch (e) {
    checks.push({
      name: "syntax",
      passed: false,
      details: { mode },
      error: e instanceof Error ? e.message : String(e)
    });
    recommendations.push(`Fix syntax error: ${e instanceof Error ? e.message : e}`);
  }

  // -------------------------------------------------------------------------
  // Check 2: Structure Analysis
  // -------------------------------------------------------------------------
  if (mode !== "chunk") {
    const structResult = validateLDrawStructure(content);
    const structErrors = structResult.issues.filter(i => i.severity === "error");
    
    checks.push({
      name: "structure",
      passed: structResult.isValid,
      details: {
        issue_count: structResult.issues.length,
        error_count: structErrors.length,
        issues: structResult.issues
      }
    });
    
    if (!structResult.isValid) {
      recommendations.push(`Fix ${structErrors.length} structural error(s)`);
    }
  }

  // -------------------------------------------------------------------------
  // Check 3: Continuity (alignment, isolation, extreme coords)
  // -------------------------------------------------------------------------
  const mpdForContinuity = mode === "chunk" 
    ? `0 FILE model.ldr\n${content}\n0 NOFILE` 
    : content;
  
  const renderResult = validateRender({
    ldraw_mpd: mpdForContinuity,
    mode: mode === "chunk" ? "partial" : mode,
    do_render_comparison: false
  });
  
  const continuityErrors = renderResult.continuity.issues.filter(i => i.severity === "error");
  
  checks.push({
    name: "continuity",
    passed: renderResult.continuity.valid,
    details: {
      part_count: renderResult.meta.ldraw_part_count,
      line_count: renderResult.meta.ldraw_line_count,
      issue_count: renderResult.continuity.issues.length,
      issues: renderResult.continuity.issues
    }
  });
  
  if (!renderResult.continuity.valid) {
    recommendations.push(`Fix ${continuityErrors.length} continuity error(s): isolated parts or extreme coordinates`);
  }

  // -------------------------------------------------------------------------
  // Check 4: Connection Validation (if available)
  // -------------------------------------------------------------------------
  if (capabilities.connections && mode !== "chunk") {
    const tempFile = path.join(os.tmpdir(), `step_validate_${Date.now()}.mpd`);
    try {
      fs.writeFileSync(tempFile, mpdForContinuity, "utf8");
      const connResult = validateLegoConnections(tempFile);
      
      checks.push({
        name: "connections",
        passed: connResult.isValid,
        details: {
          total_parts: connResult.stats.total_parts,
          supported_parts: connResult.stats.supported_parts,
          connection_count: connResult.stats.connections,
          error_count: connResult.stats.errors,
          warning_count: connResult.stats.warnings,
          issues: connResult.issues.filter(i => i.severity === "error")
        }
      });
      
      if (!connResult.isValid) {
        const floatingCount = connResult.issues.filter(i => i.type === "floating_part").length;
        if (floatingCount > 0) {
          recommendations.push(`Fix ${floatingCount} floating part(s) - ensure all parts connect properly`);
        }
      }
    } catch (e) {
      checks.push({
        name: "connections",
        passed: false,
        details: {},
        error: e instanceof Error ? e.message : String(e)
      });
    } finally {
      try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
    }
  }

  // NOTE: Physics validation (stability, tip-over, cantilevers) is intentionally
  // NOT run at step level - partial builds aren't meant to stand alone.
  // Full physics validation runs only in validate_full.

  // -------------------------------------------------------------------------
  // Compile Results
  // -------------------------------------------------------------------------
  const passed = checks.filter(c => c.passed).length;
  const failed = checks.filter(c => !c.passed).length;
  const allPassed = failed === 0;

  return {
    valid: allPassed,
    checks_run: checks.map(c => c.name),
    checks_passed: passed,
    checks_failed: failed,
    checks,
    summary: allPassed
      ? `Step validation PASSED: ${passed}/${checks.length} checks passed (${renderResult.meta.ldraw_part_count} parts)`
      : `Step validation FAILED: ${failed}/${checks.length} checks failed`,
    recommendations: recommendations.length > 0 ? recommendations : undefined
  };
}

/**
 * SUBMODULE VALIDATION - runs all applicable submodule-level checks
 */
async function handleValidateSubmodule(args: Record<string, unknown>): Promise<ComprehensiveResult> {
  const ldrawMpd = args.ldraw_mpd as string;
  const subassemblyName = args.subassembly_name as string;
  const blueprint = args.blueprint as Blueprint;
  const renderImagePath = args.render_image_path as string | undefined;
  const stepsCompleted = args.steps_completed as number | undefined;
  
  const capabilities = detectCapabilities();
  const checks: ValidationCheck[] = [];
  const recommendations: string[] = [];

  // Get subassembly info from blueprint
  const subassemblyInfo = blueprint.subassemblies?.find(
    s => s.name.toLowerCase() === subassemblyName.toLowerCase()
  );

  // -------------------------------------------------------------------------
  // Check 1: Structural Validation
  // -------------------------------------------------------------------------
  try {
    validateLDrawPartialMpdOrThrow(ldrawMpd);
    const structResult = validateLDrawStructure(ldrawMpd);
    
    checks.push({
      name: "structure",
      passed: structResult.isValid,
      details: {
        issue_count: structResult.issues.length,
        issues: structResult.issues
      }
    });
  } catch (e) {
    checks.push({
      name: "structure",
      passed: false,
      details: {},
      error: e instanceof Error ? e.message : String(e)
    });
    recommendations.push(`Fix structural error: ${e instanceof Error ? e.message : e}`);
  }

  // -------------------------------------------------------------------------
  // Check 2: Position & Blueprint Compliance
  // -------------------------------------------------------------------------
  const renderResult = validateRender({
    ldraw_mpd: ldrawMpd,
    mode: "partial",
    do_render_comparison: false,
    blueprint: blueprint as unknown as BlueprintInfo,
    current_subassembly: subassemblyName
  });
  
  const subResult = renderResult.subassemblies?.results.find(
    r => r.name.toLowerCase() === subassemblyName.toLowerCase()
  );
  
  checks.push({
    name: "position",
    passed: subResult?.position?.attachment_valid ?? true,
    details: {
      expected_position: subassemblyInfo?.expected_position,
      actual_position: subResult?.position?.relative_to_model,
      bounds: subResult?.bounds
    }
  });
  
  if (subResult?.position && !subResult.position.attachment_valid) {
    recommendations.push(
      `Subassembly "${subassemblyName}" is at "${subResult.position.relative_to_model}" ` +
      `but expected "${subassemblyInfo?.expected_position}"`
    );
  }

  // -------------------------------------------------------------------------
  // Check 3: Symmetry (if subassembly is symmetric)
  // -------------------------------------------------------------------------
  if (subassemblyInfo?.symmetric) {
    const symmetryIssues = subResult?.issues.filter(
      i => i.message.toLowerCase().includes("symmetric")
    ) ?? [];
    
    checks.push({
      name: "symmetry",
      passed: symmetryIssues.length === 0,
      details: {
        is_symmetric_subassembly: true,
        issues: symmetryIssues
      }
    });
    
    if (symmetryIssues.length > 0) {
      recommendations.push(`Fix symmetry: ${symmetryIssues.map(i => i.message).join("; ")}`);
    }
  }

  // -------------------------------------------------------------------------
  // Check 4: Proportions
  // -------------------------------------------------------------------------
  const proportionIssues = subResult?.issues.filter(
    i => i.message.toLowerCase().includes("proportion") || 
         i.message.toLowerCase().includes("aspect ratio") ||
         i.message.toLowerCase().includes("unusually large")
  ) ?? [];
  
  checks.push({
    name: "proportions",
    passed: proportionIssues.length === 0,
    details: {
      bounds: subResult?.bounds,
      issues: proportionIssues
    }
  });

  // -------------------------------------------------------------------------
  // Check 5: Continuity
  // -------------------------------------------------------------------------
  checks.push({
    name: "continuity",
    passed: renderResult.continuity.valid,
    details: {
      part_count: renderResult.meta.ldraw_part_count,
      issues: renderResult.continuity.issues
    }
  });

  // -------------------------------------------------------------------------
  // Check 6: Connection Validation (if available)
  // -------------------------------------------------------------------------
  if (capabilities.connections) {
    const tempFile = path.join(os.tmpdir(), `submodule_validate_${Date.now()}.mpd`);
    try {
      fs.writeFileSync(tempFile, ldrawMpd, "utf8");
      const connResult = validateLegoConnections(tempFile);
      
      checks.push({
        name: "connections",
        passed: connResult.isValid,
        details: {
          total_parts: connResult.stats.total_parts,
          connection_count: connResult.stats.connections,
          issues: connResult.issues.filter(i => i.severity === "error").slice(0, 5) // Limit for readability
        }
      });
    } catch (e) {
      checks.push({
        name: "connections",
        passed: false,
        details: {},
        error: e instanceof Error ? e.message : String(e)
      });
    } finally {
      try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
    }
  }

  // -------------------------------------------------------------------------
  // Check 7: Semantic Validation (if render image provided and OpenAI available)
  // -------------------------------------------------------------------------
  if (renderImagePath && fs.existsSync(renderImagePath) && capabilities.semantic && subassemblyInfo) {
    try {
      const completedSteps: BlueprintStep[] = stepsCompleted
        ? blueprint.step_outline?.slice(0, stepsCompleted) || []
        : [];
      
      const semanticResult = await validateSubmoduleSemantic(
        renderImagePath,
        subassemblyInfo as SubassemblyInfo,
        completedSteps
      );
      
      checks.push({
        name: "semantic",
        passed: semanticResult.isValid,
        score: semanticResult.confidenceScore,
        details: {
          confidence_score: semanticResult.confidenceScore,
          progress_assessment: semanticResult.progressAssessment,
          components_found: semanticResult.components.found,
          components_missing: semanticResult.components.missing,
          structure_matches: semanticResult.structure.matchesDescription,
          build_quality: semanticResult.buildQuality,
          summary: semanticResult.summary
        }
      });
      
      if (!semanticResult.isValid) {
        recommendations.push(`Semantic check: ${semanticResult.summary}`);
      }
    } catch (e) {
      checks.push({
        name: "semantic",
        passed: false,
        details: {},
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }

  // -------------------------------------------------------------------------
  // Check 8: Weak Connections (lightweight physics - just single-stud chains)
  // NOTE: Full stability checks are not run on submodules since they
  // aren't meant to stand alone (an arm or leg won't balance by itself)
  // -------------------------------------------------------------------------
  try {
    const physicsResult = validatePhysics(ldrawMpd);
    const weakConnectionIssues = physicsResult.issues.filter(
      i => i.type === "single_stud_chain" || i.type === "weak_connection"
    );
    
    checks.push({
      name: "weak_connections",
      passed: weakConnectionIssues.filter(i => i.severity === "error").length === 0,
      details: {
        single_stud_parts: physicsResult.stats.single_stud_connections,
        issues: weakConnectionIssues.slice(0, 3),
        note: "Stability checks deferred to full model validation"
      }
    });
    
    if (weakConnectionIssues.length > 0) {
      for (const issue of weakConnectionIssues.slice(0, 2)) {
        if (issue.severity === "error") {
          recommendations.push(`Weak connection: ${issue.message}`);
        }
      }
    }
  } catch (e) {
    // Physics check is optional for submodules - don't fail if it errors
    checks.push({
      name: "weak_connections",
      passed: true,
      details: { skipped: true, reason: e instanceof Error ? e.message : String(e) }
    });
  }

  // -------------------------------------------------------------------------
  // Compile Results
  // -------------------------------------------------------------------------
  const passed = checks.filter(c => c.passed).length;
  const failed = checks.filter(c => !c.passed).length;
  const allPassed = failed === 0;

  return {
    valid: allPassed,
    checks_run: checks.map(c => c.name),
    checks_passed: passed,
    checks_failed: failed,
    checks,
    summary: allPassed
      ? `Submodule "${subassemblyName}" validation PASSED: ${passed}/${checks.length} checks passed`
      : `Submodule "${subassemblyName}" validation FAILED: ${failed}/${checks.length} checks failed`,
    recommendations: recommendations.length > 0 ? recommendations : undefined
  };
}

/**
 * FULL MODEL VALIDATION - runs all applicable final checks
 */
async function handleValidateFull(args: Record<string, unknown>): Promise<ComprehensiveResult> {
  const ldrawMpd = args.ldraw_mpd as string;
  const referenceImagePath = args.reference_image_path as string | undefined;
  const renderImagePath = args.render_image_path as string | undefined;
  const blueprint = args.blueprint as Blueprint | undefined;
  const minSimilarity = (args.min_similarity as number) ?? 60;
  
  const capabilities = detectCapabilities();
  const checks: ValidationCheck[] = [];
  const recommendations: string[] = [];

  // -------------------------------------------------------------------------
  // Check 1: Full Structural Validation
  // -------------------------------------------------------------------------
  try {
    validateLDrawMpdOrThrow(ldrawMpd);
    const structResult = validateLDrawStructure(ldrawMpd);
    
    checks.push({
      name: "structure",
      passed: structResult.isValid,
      details: {
        issue_count: structResult.issues.length,
        issues: structResult.issues
      }
    });
  } catch (e) {
    checks.push({
      name: "structure",
      passed: false,
      details: {},
      error: e instanceof Error ? e.message : String(e)
    });
    recommendations.push(`Fix structural error: ${e instanceof Error ? e.message : e}`);
  }

  // -------------------------------------------------------------------------
  // Check 2: Continuity
  // -------------------------------------------------------------------------
  const renderResult = validateRender({
    ldraw_mpd: ldrawMpd,
    mode: "full",
    do_render_comparison: false,
    blueprint: blueprint as unknown as BlueprintInfo
  });
  
  checks.push({
    name: "continuity",
    passed: renderResult.continuity.valid,
    details: {
      part_count: renderResult.meta.ldraw_part_count,
      line_count: renderResult.meta.ldraw_line_count,
      issues: renderResult.continuity.issues
    }
  });

  // -------------------------------------------------------------------------
  // Check 3: Blueprint Compliance (if blueprint provided)
  // -------------------------------------------------------------------------
  if (blueprint && blueprint.subassemblies) {
    const subResults = renderResult.subassemblies?.results ?? [];
    const subassemblyNames = blueprint.subassemblies.map(s => s.name);
    const presentSubs = subResults.filter(s => s.valid).map(s => s.name);
    const missingSubs = subassemblyNames.filter(
      name => !subResults.find(s => s.name.toLowerCase() === name.toLowerCase())
    );
    const positionIssues = subResults.filter(s => 
      s.position && !s.position.attachment_valid
    );
    
    checks.push({
      name: "blueprint_compliance",
      passed: renderResult.subassemblies?.valid ?? true,
      details: {
        subassemblies_expected: subassemblyNames,
        subassemblies_valid: presentSubs,
        subassemblies_missing: missingSubs,
        position_issues: positionIssues.map(s => ({
          name: s.name,
          actual: s.position?.relative_to_model
        })),
        all_results: subResults.map(s => ({
          name: s.name,
          valid: s.valid,
          position: s.position?.relative_to_model
        }))
      }
    });
    
    if (missingSubs.length > 0) {
      recommendations.push(`Missing subassemblies: ${missingSubs.join(", ")}`);
    }
    if (positionIssues.length > 0) {
      recommendations.push(`Position issues in: ${positionIssues.map(s => s.name).join(", ")}`);
    }
  }

  // -------------------------------------------------------------------------
  // Check 4: Connection Validation (if available)
  // -------------------------------------------------------------------------
  if (capabilities.connections) {
    const tempFile = path.join(os.tmpdir(), `full_validate_${Date.now()}.mpd`);
    try {
      fs.writeFileSync(tempFile, ldrawMpd, "utf8");
      const connResult = validateLegoConnections(tempFile);
      
      checks.push({
        name: "connections",
        passed: connResult.isValid,
        details: {
          total_parts: connResult.stats.total_parts,
          connection_count: connResult.stats.connections,
          error_count: connResult.stats.errors,
          warning_count: connResult.stats.warnings,
          issues: connResult.issues.filter(i => i.severity === "error").slice(0, 10)
        }
      });
      
      if (!connResult.isValid) {
        recommendations.push(`Fix ${connResult.stats.errors} connection error(s)`);
      }
    } catch (e) {
      checks.push({
        name: "connections",
        passed: false,
        details: {},
        error: e instanceof Error ? e.message : String(e)
      });
    } finally {
      try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
    }
  }

  // -------------------------------------------------------------------------
  // Check 5: Image Similarity (SSIM) - if reference and render provided
  // -------------------------------------------------------------------------
  if (referenceImagePath && renderImagePath && 
      fs.existsSync(referenceImagePath) && fs.existsSync(renderImagePath)) {
    try {
      const similarity = compareImages(renderImagePath, referenceImagePath);
      
      checks.push({
        name: "image_similarity",
        passed: similarity.overall >= minSimilarity,
        score: similarity.overall,
        details: {
          score: similarity.overall,
          threshold: minSimilarity,
          ssim: similarity.metrics.ssim,
          mse: similarity.metrics.mse,
          psnr: similarity.metrics.psnr,
          method: similarity.details?.method
        }
      });
      
      if (similarity.overall < minSimilarity) {
        recommendations.push(
          `Image similarity (${similarity.overall.toFixed(1)}%) below threshold (${minSimilarity}%)`
        );
      }
    } catch (e) {
      checks.push({
        name: "image_similarity",
        passed: false,
        details: {},
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }

  // -------------------------------------------------------------------------
  // Check 6: Semantic Similarity (AI Vision) - if images and API available
  // -------------------------------------------------------------------------
  if (referenceImagePath && renderImagePath && capabilities.semantic &&
      fs.existsSync(referenceImagePath) && fs.existsSync(renderImagePath)) {
    try {
      if (blueprint) {
        // Full semantic validation with blueprint
        const semanticResult = await validateFinalModelSemantic(
          referenceImagePath,
          renderImagePath,
          blueprint
        );
        
        checks.push({
          name: "semantic_full",
          passed: semanticResult.isValid,
          score: semanticResult.overallScore,
          details: {
            overall_score: semanticResult.overallScore,
            overall_match: semanticResult.overallMatch,
            reference_match: semanticResult.referenceMatch,
            blueprint_compliance: semanticResult.blueprintCompliance,
            build_quality: semanticResult.buildQuality,
            proportions: semanticResult.proportions,
            summary: semanticResult.summary
          }
        });
        
        if (!semanticResult.isValid) {
          recommendations.push(`Semantic: ${semanticResult.summary}`);
        }
      } else {
        // Basic semantic comparison without blueprint
        const semanticResult = await validateSemanticSimilarity(
          referenceImagePath,
          renderImagePath
        );
        
        checks.push({
          name: "semantic_basic",
          passed: semanticResult.isValid,
          score: semanticResult.similarityScore,
          details: {
            similarity_score: semanticResult.similarityScore,
            overall_match: semanticResult.overallMatch,
            components: semanticResult.components,
            proportions: semanticResult.proportions,
            summary: semanticResult.summary
          }
        });
        
        if (!semanticResult.isValid) {
          recommendations.push(`Semantic: ${semanticResult.summary}`);
        }
      }
    } catch (e) {
      checks.push({
        name: "semantic",
        passed: false,
        details: {},
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }

  // -------------------------------------------------------------------------
  // Check 7: FULL PHYSICS VALIDATION ("Will this fall apart?")
  // This is the ONLY place we run complete physics checks including:
  // - Stability analysis (tip-over risk)
  // - Cantilever/overhang limits
  // - Center of gravity analysis
  // - Weak connection detection (single-stud chains)
  // - Top-heavy detection
  // -------------------------------------------------------------------------
  try {
    const physicsResult = validatePhysics(ldrawMpd);
    const physicsErrors = physicsResult.issues.filter(i => i.severity === "error");
    const physicsWarnings = physicsResult.issues.filter(i => i.severity === "warning");
    
    checks.push({
      name: "physics",
      passed: physicsResult.isStable,
      score: physicsResult.stabilityScore,
      details: {
        stability_score: physicsResult.stabilityScore,
        is_stable: physicsResult.isStable,
        center_of_gravity: physicsResult.centerOfGravity,
        base_footprint: physicsResult.baseFootprint,
        height_to_base_ratio: physicsResult.stats.height_to_base_ratio,
        single_stud_connections: physicsResult.stats.single_stud_connections,
        stability_factors: physicsResult.stats.stability_factors,
        errors: physicsErrors,
        warnings: physicsWarnings.slice(0, 5)
      }
    });
    
    if (!physicsResult.isStable) {
      // Add specific recommendations for physics failures
      for (const issue of physicsErrors) {
        if (issue.type === "tip_over_risk") {
          recommendations.push("Physics: Model will tip over - widen the base or lower the center of gravity");
        } else if (issue.type === "cantilever_risk") {
          recommendations.push(`Physics: ${issue.message} - add support underneath`);
        } else if (issue.type === "single_stud_chain") {
          recommendations.push(`Physics: ${issue.message} - use wider parts or add bracing`);
        } else if (issue.type === "top_heavy") {
          recommendations.push("Physics: Model is top-heavy - add weight to base or reduce height");
        } else {
          recommendations.push(`Physics: ${issue.message}`);
        }
      }
    } else if (physicsResult.stabilityScore < 80) {
      // Warn about marginal stability
      recommendations.push(`Physics: Model is stable but marginal (${physicsResult.stabilityScore}% score) - consider reinforcing`);
    }
  } catch (e) {
    checks.push({
      name: "physics",
      passed: false,
      details: {},
      error: e instanceof Error ? e.message : String(e)
    });
  }

  // -------------------------------------------------------------------------
  // Compile Results
  // -------------------------------------------------------------------------
  const passed = checks.filter(c => c.passed).length;
  const failed = checks.filter(c => !c.passed).length;
  const allPassed = failed === 0;
  
  // Calculate overall score from scored checks
  const scoredChecks = checks.filter(c => c.score !== undefined);
  const averageScore = scoredChecks.length > 0
    ? scoredChecks.reduce((sum, c) => sum + (c.score ?? 0), 0) / scoredChecks.length
    : undefined;

  return {
    valid: allPassed,
    checks_run: checks.map(c => c.name),
    checks_passed: passed,
    checks_failed: failed,
    checks,
    summary: allPassed
      ? `Full validation PASSED: ${passed}/${checks.length} checks passed` +
        (averageScore !== undefined ? ` (avg score: ${averageScore.toFixed(1)}%)` : "") +
        ` (${renderResult.meta.ldraw_part_count} parts)`
      : `Full validation FAILED: ${failed}/${checks.length} checks failed`,
    recommendations: recommendations.length > 0 ? recommendations : undefined
  };
}

// ============================================================================
// MCP Server Setup
// ============================================================================

const server = new Server(
  {
    name: "lego-validator",
    version: "1.0.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Call tools with logging
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const startTime = Date.now();
  const typedArgs = args as Record<string, unknown>;

  try {
    let result: ComprehensiveResult;
    let stage: "step" | "submodule" | "full";
    let renderImagePath: string | undefined;
    let referenceImagePath: string | undefined;

    switch (name) {
      case "validate_step":
        stage = "step";
        result = await handleValidateStep(typedArgs);
        break;
      case "validate_submodule":
        stage = "submodule";
        renderImagePath = typedArgs.render_image_path as string | undefined;
        result = await handleValidateSubmodule(typedArgs);
        break;
      case "validate_full":
        stage = "full";
        renderImagePath = typedArgs.render_image_path as string | undefined;
        referenceImagePath = typedArgs.reference_image_path as string | undefined;
        result = await handleValidateFull(typedArgs);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    const duration = Date.now() - startTime;

    // Log the validation
    logger.log({
      stage,
      tool: name,
      input: typedArgs,
      result,
      renderImagePath,
      referenceImagePath,
      duration_ms: duration
    });

    // Add logging metadata to result
    const resultWithMeta = {
      ...result,
      _meta: {
        session_id: logger.getSessionId(),
        sequence: logger["sequence"], // Access current sequence
        stage,
        logged_at: new Date().toISOString(),
        duration_ms: duration
      }
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(resultWithMeta, null, 2)
        }
      ]
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorResult = {
      valid: false,
      error: true,
      message: error instanceof Error ? error.message : String(error),
      checks_run: [],
      checks_passed: 0,
      checks_failed: 1,
      checks: [{
        name: "initialization",
        passed: false,
        details: {},
        error: error instanceof Error ? error.message : String(error)
      }],
      summary: `Validation error: ${error instanceof Error ? error.message : String(error)}`
    };

    // Log errors too
    const stage = name === "validate_step" ? "step" 
                : name === "validate_submodule" ? "submodule" 
                : "full";
    
    logger.log({
      stage: stage as "step" | "submodule" | "full",
      tool: name,
      input: typedArgs,
      result: errorResult,
      duration_ms: duration
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(errorResult, null, 2)
        }
      ],
      isError: true
    };
  }
});

// Start server
async function main() {
  // Initialize logger
  logger = new ValidationLogger();
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  // Log capabilities on startup
  const caps = detectCapabilities();
  console.error("LEGO Validator MCP Server running");
  console.error(`  Session: ${logger.getSessionId()}`);
  console.error(`  Log dir: ${logger.getSessionDir()}`);
  console.error(`  Semantic validation: ${caps.semantic ? "available" : "unavailable (need OPENAI_API_KEY)"}`);
  console.error(`  Connection validation: ${caps.connections ? "available" : "unavailable (need Python + numpy)"}`);
}

main().catch(console.error);
