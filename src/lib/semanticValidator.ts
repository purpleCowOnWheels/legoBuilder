import { spawnSync } from "node:child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Types
// ============================================================================

export interface SemanticValidationResult {
  isValid: boolean;
  similarityScore: number;
  components: {
    expected: string[];
    found: string[];
    missing: string[];
    misplaced: string[];
  };
  proportions?: {
    correct: boolean;
    issues: string[];
  };
  orientation?: {
    correct: boolean;
    issue?: string;
  };
  overallMatch: "excellent" | "good" | "fair" | "poor";
  issues: Array<{
    type: string;
    component?: string;
    severity: "error" | "warning";
    expected?: string;
    actual?: string;
  }>;
  summary: string;
  method?: string;
  model?: string;
  error?: string;
}

/**
 * Result from submodule/incremental semantic validation
 */
export interface SubmoduleSemanticResult {
  isValid: boolean;
  confidenceScore: number;
  subassemblyName: string;
  components: {
    expected: string[];
    found: string[];
    missing: string[];
    extra: string[];
  };
  structure: {
    matchesDescription: boolean;
    issues: string[];
  };
  proportions: {
    reasonable: boolean;
    issues: string[];
  };
  symmetry: {
    checked: boolean;
    symmetric: boolean;
    issues: string[];
  };
  buildQuality: {
    connectionsValid: boolean;
    floatingPieces: boolean;
    issues: string[];
  };
  progressAssessment: "on_track" | "ahead" | "behind" | "off_track";
  issues: Array<{
    type: string;
    component?: string;
    severity: "error" | "warning";
  }>;
  summary: string;
  method?: string;
  model?: string;
  error?: string;
}

/**
 * Result from final/complete model semantic validation
 */
export interface FinalSemanticResult {
  isValid: boolean;
  overallScore: number;
  referenceMatch: {
    score: number;
    capturesEssence: boolean;
    keyFeaturesPresent: string[];
    keyFeaturesMissing: string[];
    shapeSimilarity: "excellent" | "good" | "fair" | "poor";
    issues: string[];
  };
  blueprintCompliance: {
    score: number;
    subassembliesPresent: string[];
    subassembliesMissing: string[];
    positionIssues: string[];
    issues: string[];
  };
  buildQuality: {
    score: number;
    connectionsValid: boolean;
    structuralIntegrity: boolean;
    floatingPieces: boolean;
    issues: string[];
  };
  proportions: {
    score: number;
    reasonable: boolean;
    symmetryValid: boolean;
    issues: string[];
  };
  overallMatch: "excellent" | "good" | "fair" | "poor";
  issues: Array<{
    type: string;
    component?: string;
    severity: "error" | "warning";
    description?: string;
  }>;
  summary: string;
  method?: string;
  model?: string;
  error?: string;
}

/**
 * Subassembly info for validation
 */
export interface SubassemblyInfo {
  name: string;
  description: string;
  expected_components?: string[];
  expected_position?: string;
  symmetric?: boolean;
}

/**
 * Blueprint step info
 */
export interface BlueprintStep {
  step: number;
  title: string;
  description: string;
  subassembly?: string;
}

/**
 * Full blueprint structure
 */
export interface Blueprint {
  subassemblies: SubassemblyInfo[];
  step_outline: BlueprintStep[];
}

/**
 * Validate that a rendered LEGO model is semantically/conceptually similar to the input image.
 * 
 * Uses AI vision to check:
 * - Major components are present (head, body, limbs, etc.)
 * - Components are in correct relative positions
 * - Proportions are reasonable
 * - Overall structure matches the reference
 * 
 * This is different from pixel-level similarity (SSIM) - it validates conceptual accuracy.
 * 
 * @param inputImagePath - Path to original reference image
 * @param renderImagePath - Path to rendered LEGO model
 * @param options - Validation options
 * @returns Semantic validation result
 */
export async function validateSemanticSimilarity(
  inputImagePath: string,
  renderImagePath: string,
  options: {
    apiKey?: string;
    model?: string;
    minSimilarity?: number;
  } = {}
): Promise<SemanticValidationResult> {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not provided");
  }
  
  const scriptPath = path.join(__dirname, "../../scripts/semantic_validator.py");
  
  const result = spawnSync(
    "python3",
    [scriptPath, inputImagePath, renderImagePath],
    {
      encoding: "utf8",
      timeout: 90000, // 90 seconds (vision API can be slow)
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        OPENAI_API_KEY: apiKey,
        OPENAI_MODEL: options.model || "gpt-4o"
      }
    }
  );

  if (result.error) {
    throw new Error(`Semantic validation failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`Semantic validator error: ${result.stderr || result.stdout}`);
  }

  try {
    const data = JSON.parse(result.stdout);
    
    return {
      isValid: data.is_valid,
      similarityScore: data.similarity_score || 0,
      components: {
        expected: data.components?.expected || [],
        found: data.components?.found || [],
        missing: data.components?.missing || [],
        misplaced: data.components?.misplaced || []
      },
      proportions: data.proportions,
      orientation: data.orientation,
      overallMatch: data.overall_match || "poor",
      issues: data.issues || [],
      summary: data.summary || data.analysis || "",
      method: data.method,
      model: data.model,
      error: data.error
    };
  } catch (e) {
    throw new Error(`Failed to parse validation result: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Quick check if specific components are present in the rendered model.
 * Faster than full semantic validation.
 * 
 * @param renderImagePath - Path to rendered LEGO model
 * @param expectedComponents - List of components to check for (e.g., ["head", "arms", "base"])
 * @returns Component check result
 */
export async function quickComponentCheck(
  renderImagePath: string,
  expectedComponents: string[]
): Promise<{
  foundComponents: string[];
  missingComponents: string[];
  issues: Array<{ type: string; component: string }>;
}> {
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not set");
  }
  
  // Use Python script with component check mode
  const scriptPath = path.join(__dirname, "../../scripts/semantic_validator.py");
  
  // For now, just use the full validation - we can optimize later
  const result = await validateSemanticSimilarity("", renderImagePath, { apiKey });
  
  const found = new Set(result.components.found);
  const missing = expectedComponents.filter(comp => !found.has(comp));
  
  return {
    foundComponents: result.components.found,
    missingComponents: missing,
    issues: missing.map(comp => ({ type: "missing_component", component: comp }))
  };
}

/**
 * Check if semantic validation is available (Python + OpenAI API).
 */
export function isSemanticValidationAvailable(): boolean {
  try {
    // Check Python
    const pythonCheck = spawnSync("python3", ["--version"], {
      encoding: "utf8",
      timeout: 5000
    });
    
    if (pythonCheck.status !== 0) {
      return false;
    }
    
    // Check OpenAI API key
    if (!process.env.OPENAI_API_KEY) {
      return false;
    }
    
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// INCREMENTAL VALIDATION (can run during build)
// ============================================================================

/**
 * Validate a submodule/partial build against its blueprint specification.
 * 
 * This is the key function for INCREMENTAL validation - it doesn't require
 * a reference image, only the blueprint description of what should exist.
 * 
 * Use this during MPD generation to validate each chunk/subassembly as it's built.
 * 
 * @param renderImagePath - Path to rendered image of partial build
 * @param subassemblyInfo - Blueprint info about this subassembly
 * @param stepsCompleted - Blueprint steps completed so far
 * @param options - Validation options
 * @returns Submodule semantic validation result
 */
export async function validateSubmoduleSemantic(
  renderImagePath: string,
  subassemblyInfo: SubassemblyInfo,
  stepsCompleted: BlueprintStep[] = [],
  options: {
    apiKey?: string;
    model?: string;
  } = {}
): Promise<SubmoduleSemanticResult> {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not provided");
  }
  
  const scriptPath = path.join(__dirname, "../../scripts/semantic_validator.py");
  
  // Serialize arguments to JSON
  const subassemblyJson = JSON.stringify(subassemblyInfo);
  const stepsJson = JSON.stringify(stepsCompleted);
  
  const result = spawnSync(
    "python3",
    [scriptPath, "submodule", renderImagePath, subassemblyJson, stepsJson],
    {
      encoding: "utf8",
      timeout: 90000,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        OPENAI_API_KEY: apiKey,
        OPENAI_MODEL: options.model || "gpt-4o"
      }
    }
  );

  if (result.error) {
    throw new Error(`Submodule semantic validation failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`Submodule semantic validator error: ${result.stderr || result.stdout}`);
  }

  try {
    const data = JSON.parse(result.stdout);
    
    return {
      isValid: data.is_valid ?? false,
      confidenceScore: data.confidence_score ?? 0,
      subassemblyName: data.subassembly_name ?? subassemblyInfo.name,
      components: {
        expected: data.components?.expected ?? [],
        found: data.components?.found ?? [],
        missing: data.components?.missing ?? [],
        extra: data.components?.extra ?? []
      },
      structure: {
        matchesDescription: data.structure?.matches_description ?? false,
        issues: data.structure?.issues ?? []
      },
      proportions: {
        reasonable: data.proportions?.reasonable ?? true,
        issues: data.proportions?.issues ?? []
      },
      symmetry: {
        checked: data.symmetry?.checked ?? false,
        symmetric: data.symmetry?.symmetric ?? true,
        issues: data.symmetry?.issues ?? []
      },
      buildQuality: {
        connectionsValid: data.build_quality?.connections_valid ?? true,
        floatingPieces: data.build_quality?.floating_pieces ?? false,
        issues: data.build_quality?.issues ?? []
      },
      progressAssessment: data.progress_assessment ?? "on_track",
      issues: data.issues ?? [],
      summary: data.summary ?? "",
      method: data.method,
      model: data.model,
      error: data.error
    };
  } catch (e) {
    throw new Error(`Failed to parse submodule validation result: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Quick structural check for incremental validation.
 * Faster than full semantic check - just validates basic component presence.
 * 
 * @param renderImagePath - Path to rendered partial image
 * @param expectedComponents - List of components that should be present
 * @returns Quick validation result
 */
export async function quickIncrementalCheck(
  renderImagePath: string,
  expectedComponents: string[],
  options: { apiKey?: string } = {}
): Promise<{
  valid: boolean;
  foundComponents: string[];
  missingComponents: string[];
  confidence: number;
}> {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not provided");
  }
  
  // Use submodule validation with minimal info
  const result = await validateSubmoduleSemantic(
    renderImagePath,
    {
      name: "partial_build",
      description: "Partial build in progress",
      expected_components: expectedComponents
    },
    [],
    { apiKey }
  );
  
  return {
    valid: result.isValid,
    foundComponents: result.components.found,
    missingComponents: result.components.missing,
    confidence: result.confidenceScore
  };
}

// ============================================================================
// FINAL VALIDATION (requires complete model + reference image)
// ============================================================================

/**
 * Comprehensive semantic validation for a COMPLETE model.
 * 
 * This validation can ONLY run when the entire model is complete because it:
 * 1. Compares against the original reference image
 * 2. Validates all subassemblies are present and in correct positions
 * 3. Checks overall blueprint compliance
 * 
 * @param inputImagePath - Path to original reference image
 * @param renderImagePath - Path to rendered complete model
 * @param blueprint - Full blueprint with subassemblies and step_outline
 * @param options - Validation options
 * @returns Comprehensive final validation result
 */
export async function validateFinalModelSemantic(
  inputImagePath: string,
  renderImagePath: string,
  blueprint: Blueprint,
  options: {
    apiKey?: string;
    model?: string;
  } = {}
): Promise<FinalSemanticResult> {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not provided");
  }
  
  const scriptPath = path.join(__dirname, "../../scripts/semantic_validator.py");
  
  // Serialize blueprint to JSON
  const blueprintJson = JSON.stringify(blueprint);
  
  const result = spawnSync(
    "python3",
    [scriptPath, "final", inputImagePath, renderImagePath, blueprintJson],
    {
      encoding: "utf8",
      timeout: 120000, // 2 minutes for comprehensive check
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        OPENAI_API_KEY: apiKey,
        OPENAI_MODEL: options.model || "gpt-4o"
      }
    }
  );

  if (result.error) {
    throw new Error(`Final semantic validation failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`Final semantic validator error: ${result.stderr || result.stdout}`);
  }

  try {
    const data = JSON.parse(result.stdout);
    
    return {
      isValid: data.is_valid ?? false,
      overallScore: data.overall_score ?? 0,
      referenceMatch: {
        score: data.reference_match?.score ?? 0,
        capturesEssence: data.reference_match?.captures_essence ?? false,
        keyFeaturesPresent: data.reference_match?.key_features_present ?? [],
        keyFeaturesMissing: data.reference_match?.key_features_missing ?? [],
        shapeSimilarity: data.reference_match?.shape_similarity ?? "poor",
        issues: data.reference_match?.issues ?? []
      },
      blueprintCompliance: {
        score: data.blueprint_compliance?.score ?? 0,
        subassembliesPresent: data.blueprint_compliance?.subassemblies_present ?? [],
        subassembliesMissing: data.blueprint_compliance?.subassemblies_missing ?? [],
        positionIssues: data.blueprint_compliance?.position_issues ?? [],
        issues: data.blueprint_compliance?.issues ?? []
      },
      buildQuality: {
        score: data.build_quality?.score ?? 0,
        connectionsValid: data.build_quality?.connections_valid ?? true,
        structuralIntegrity: data.build_quality?.structural_integrity ?? true,
        floatingPieces: data.build_quality?.floating_pieces ?? false,
        issues: data.build_quality?.issues ?? []
      },
      proportions: {
        score: data.proportions?.score ?? 0,
        reasonable: data.proportions?.reasonable ?? true,
        symmetryValid: data.proportions?.symmetry_valid ?? true,
        issues: data.proportions?.issues ?? []
      },
      overallMatch: data.overall_match ?? "poor",
      issues: data.issues ?? [],
      summary: data.summary ?? "",
      method: data.method,
      model: data.model,
      error: data.error
    };
  } catch (e) {
    throw new Error(`Failed to parse final validation result: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ============================================================================
// Validation Category Helpers
// ============================================================================

/**
 * List of validations that can run incrementally (during build).
 * These do NOT require a reference image or complete model.
 */
export const INCREMENTAL_VALIDATIONS = [
  "submodule_semantic",     // Blueprint-based semantic check for submodules
  "quick_component_check",  // Fast component presence check
  "structure_validation",   // LDraw syntax and structure
  "continuity_check",       // Part alignment and connectivity
  "subassembly_position",   // Position relative to partial model
  "symmetry_check",         // For symmetric subassemblies
  "proportion_check"        // Reasonable proportions within subassembly
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
  "cross_subassembly_check"      // Connections between all subassemblies
] as const;

export type IncrementalValidationType = typeof INCREMENTAL_VALIDATIONS[number];
export type FinalOnlyValidationType = typeof FINAL_ONLY_VALIDATIONS[number];
