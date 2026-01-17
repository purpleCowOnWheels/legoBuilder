#!/usr/bin/env npx ts-node
/**
 * INCREMENTAL VALIDATION TESTS
 * 
 * These tests can run DURING the build process, as each chunk/submodule is generated.
 * They do NOT require:
 *   - A reference image (original input)
 *   - A complete model
 * 
 * They validate against:
 *   - Blueprint descriptions
 *   - Expected components for each subassembly
 *   - Structural integrity of partial builds
 * 
 * Usage:
 *   npx ts-node scripts/test-incremental-validation.ts [render_image] [--subassembly name]
 * 
 * Example:
 *   npx ts-node scripts/test-incremental-validation.ts ./data/partial_render.png --subassembly torso
 */

import path from "path";
import fs from "fs";
import { config } from "dotenv";

// Load environment
config({ path: path.join(process.cwd(), ".env.local") });

import {
  validateSubmoduleSemantic,
  quickIncrementalCheck,
  isSemanticValidationAvailable,
  INCREMENTAL_VALIDATIONS,
  type SubassemblyInfo,
  type BlueprintStep
} from "../src/lib/semanticValidator";
import { validateRender } from "../src/lib/renderValidation";

// ============================================================================
// Test Configuration
// ============================================================================

// Example blueprint for testing (matches typical LEGO character structure)
const TEST_BLUEPRINT = {
  subassemblies: [
    {
      name: "base",
      description: "Foundation plate with attachment points for legs",
      expected_components: ["base plate", "leg attachment studs"],
      expected_position: "bottom",
      symmetric: true
    },
    {
      name: "legs",
      description: "Left and right leg assemblies",
      expected_components: ["left leg", "right leg", "hip joints"],
      expected_position: "bottom",
      symmetric: true
    },
    {
      name: "torso",
      description: "Main body/chest section with arm attachment points",
      expected_components: ["chest plate", "shoulder joints", "core body"],
      expected_position: "center",
      symmetric: true
    },
    {
      name: "arms",
      description: "Left and right arm assemblies",
      expected_components: ["left arm", "right arm", "hands"],
      expected_position: "sides",
      symmetric: true
    },
    {
      name: "head",
      description: "Head with face details",
      expected_components: ["head structure", "face features"],
      expected_position: "top",
      symmetric: false
    }
  ],
  step_outline: [
    { step: 1, title: "Base Foundation", description: "Build the foundation plate", subassembly: "base" },
    { step: 2, title: "Left Leg", description: "Build left leg assembly", subassembly: "legs" },
    { step: 3, title: "Right Leg", description: "Build right leg assembly", subassembly: "legs" },
    { step: 4, title: "Attach Legs", description: "Connect legs to base", subassembly: "legs" },
    { step: 5, title: "Lower Torso", description: "Build lower body section", subassembly: "torso" },
    { step: 6, title: "Upper Torso", description: "Build upper body/chest", subassembly: "torso" },
    { step: 7, title: "Left Arm", description: "Build left arm", subassembly: "arms" },
    { step: 8, title: "Right Arm", description: "Build right arm", subassembly: "arms" },
    { step: 9, title: "Attach Arms", description: "Connect arms to torso", subassembly: "arms" },
    { step: 10, title: "Head Base", description: "Build head structure", subassembly: "head" },
    { step: 11, title: "Face Details", description: "Add face features", subassembly: "head" },
    { step: 12, title: "Final Assembly", description: "Attach head to complete model", subassembly: "head" }
  ]
};

// ============================================================================
// Incremental Test Functions
// ============================================================================

interface IncrementalTestResult {
  testName: string;
  passed: boolean;
  duration: number;
  details: Record<string, unknown>;
  error?: string;
}

/**
 * Test 1: Submodule Semantic Validation
 * 
 * Validates that a partial render matches its blueprint description.
 * This is the primary incremental semantic test.
 */
async function testSubmoduleSemantic(
  renderImagePath: string,
  subassemblyName: string,
  stepsCompleted: number
): Promise<IncrementalTestResult> {
  const testName = `Submodule Semantic: ${subassemblyName}`;
  const start = Date.now();
  
  try {
    // Find subassembly info
    const subassemblyInfo = TEST_BLUEPRINT.subassemblies.find(
      s => s.name.toLowerCase() === subassemblyName.toLowerCase()
    );
    
    if (!subassemblyInfo) {
      throw new Error(`Unknown subassembly: ${subassemblyName}`);
    }
    
    // Get completed steps
    const completedSteps = TEST_BLUEPRINT.step_outline.slice(0, stepsCompleted);
    
    const result = await validateSubmoduleSemantic(
      renderImagePath,
      subassemblyInfo,
      completedSteps
    );
    
    return {
      testName,
      passed: result.isValid,
      duration: Date.now() - start,
      details: {
        confidenceScore: result.confidenceScore,
        progressAssessment: result.progressAssessment,
        componentsFound: result.components.found,
        componentsMissing: result.components.missing,
        structureMatches: result.structure.matchesDescription,
        buildQuality: result.buildQuality,
        summary: result.summary
      }
    };
  } catch (e) {
    return {
      testName,
      passed: false,
      duration: Date.now() - start,
      details: {},
      error: e instanceof Error ? e.message : String(e)
    };
  }
}

/**
 * Test 2: Quick Component Check
 * 
 * Fast validation that expected components are present.
 * Good for real-time feedback during generation.
 */
async function testQuickComponentCheck(
  renderImagePath: string,
  expectedComponents: string[]
): Promise<IncrementalTestResult> {
  const testName = "Quick Component Check";
  const start = Date.now();
  
  try {
    const result = await quickIncrementalCheck(renderImagePath, expectedComponents);
    
    return {
      testName,
      passed: result.valid,
      duration: Date.now() - start,
      details: {
        confidence: result.confidence,
        found: result.foundComponents,
        missing: result.missingComponents,
        coveragePercent: Math.round(
          (result.foundComponents.length / expectedComponents.length) * 100
        )
      }
    };
  } catch (e) {
    return {
      testName,
      passed: false,
      duration: Date.now() - start,
      details: {},
      error: e instanceof Error ? e.message : String(e)
    };
  }
}

/**
 * Test 3: Structural Validation (no image needed)
 * 
 * Validates LDraw MPD structure without rendering.
 */
function testStructuralValidation(
  ldrawMpd: string,
  mode: "partial" | "chunk" = "partial"
): IncrementalTestResult {
  const testName = `Structural Validation (${mode})`;
  const start = Date.now();
  
  try {
    const result = validateRender({
      ldraw_mpd: ldrawMpd,
      mode,
      do_render_comparison: false
    });
    
    return {
      testName,
      passed: result.valid,
      duration: Date.now() - start,
      details: {
        structureValid: result.structure.valid,
        continuityValid: result.continuity.valid,
        partCount: result.meta.ldraw_part_count,
        lineCount: result.meta.ldraw_line_count,
        structureIssues: result.structure.issues,
        continuityIssues: result.continuity.issues
      }
    };
  } catch (e) {
    return {
      testName,
      passed: false,
      duration: Date.now() - start,
      details: {},
      error: e instanceof Error ? e.message : String(e)
    };
  }
}

/**
 * Test 4: Subassembly Position Validation
 * 
 * Checks if subassembly is in the expected position within the model.
 */
function testSubassemblyPosition(
  ldrawMpd: string,
  subassemblyName: string
): IncrementalTestResult {
  const testName = `Subassembly Position: ${subassemblyName}`;
  const start = Date.now();
  
  try {
    const subassemblyInfo = TEST_BLUEPRINT.subassemblies.find(
      s => s.name.toLowerCase() === subassemblyName.toLowerCase()
    );
    
    if (!subassemblyInfo) {
      throw new Error(`Unknown subassembly: ${subassemblyName}`);
    }
    
    const result = validateRender({
      ldraw_mpd: ldrawMpd,
      mode: "partial",
      do_render_comparison: false,
      blueprint: TEST_BLUEPRINT,
      current_subassembly: subassemblyName
    });
    
    const subResult = result.subassemblies?.results.find(
      r => r.name.toLowerCase() === subassemblyName.toLowerCase()
    );
    
    return {
      testName,
      passed: subResult?.valid ?? false,
      duration: Date.now() - start,
      details: {
        expectedPosition: subassemblyInfo.expected_position,
        actualPosition: subResult?.position?.relative_to_model,
        positionValid: subResult?.position?.attachment_valid,
        bounds: subResult?.bounds,
        issues: subResult?.issues
      }
    };
  } catch (e) {
    return {
      testName,
      passed: false,
      duration: Date.now() - start,
      details: {},
      error: e instanceof Error ? e.message : String(e)
    };
  }
}

/**
 * Test 5: Symmetry Check
 * 
 * For symmetric subassemblies, validates left-right symmetry.
 */
function testSymmetryCheck(
  ldrawMpd: string,
  subassemblyName: string
): IncrementalTestResult {
  const testName = `Symmetry Check: ${subassemblyName}`;
  const start = Date.now();
  
  try {
    const subassemblyInfo = TEST_BLUEPRINT.subassemblies.find(
      s => s.name.toLowerCase() === subassemblyName.toLowerCase()
    );
    
    if (!subassemblyInfo) {
      throw new Error(`Unknown subassembly: ${subassemblyName}`);
    }
    
    if (!subassemblyInfo.symmetric) {
      return {
        testName,
        passed: true,
        duration: Date.now() - start,
        details: { skipped: true, reason: "Subassembly is not marked as symmetric" }
      };
    }
    
    const result = validateRender({
      ldraw_mpd: ldrawMpd,
      mode: "partial",
      do_render_comparison: false,
      blueprint: TEST_BLUEPRINT,
      current_subassembly: subassemblyName
    });
    
    // Check for symmetry issues in the subassembly results
    const symmetryIssues = result.subassemblies?.issues.filter(
      i => i.message.toLowerCase().includes("symmetric")
    ) ?? [];
    
    return {
      testName,
      passed: symmetryIssues.length === 0,
      duration: Date.now() - start,
      details: {
        isSymmetricSubassembly: true,
        symmetryIssues
      }
    };
  } catch (e) {
    return {
      testName,
      passed: false,
      duration: Date.now() - start,
      details: {},
      error: e instanceof Error ? e.message : String(e)
    };
  }
}

// ============================================================================
// Test Runner
// ============================================================================

async function runIncrementalTests(options: {
  renderImagePath?: string;
  ldrawMpd?: string;
  subassemblyName?: string;
  stepsCompleted?: number;
}) {
  console.log("=".repeat(70));
  console.log("INCREMENTAL VALIDATION TESTS");
  console.log("These tests can run DURING the build process");
  console.log("=".repeat(70));
  console.log();
  
  console.log("Available incremental validations:");
  INCREMENTAL_VALIDATIONS.forEach(v => console.log(`  - ${v}`));
  console.log();
  
  const results: IncrementalTestResult[] = [];
  const subassembly = options.subassemblyName || "torso";
  const steps = options.stepsCompleted || 6;
  
  // Check prerequisites
  const hasImage = options.renderImagePath && fs.existsSync(options.renderImagePath);
  const hasMpd = !!options.ldrawMpd;
  const hasSemanticAvailable = isSemanticValidationAvailable();
  
  console.log("Test Configuration:");
  console.log(`  Subassembly: ${subassembly}`);
  console.log(`  Steps completed: ${steps}`);
  console.log(`  Has render image: ${hasImage}`);
  console.log(`  Has LDraw MPD: ${hasMpd}`);
  console.log(`  Semantic validation available: ${hasSemanticAvailable}`);
  console.log();
  
  // Run tests based on available inputs
  console.log("-".repeat(70));
  console.log("Running Tests...");
  console.log("-".repeat(70));
  
  // Tests requiring rendered image
  if (hasImage && hasSemanticAvailable) {
    console.log("\n[Image-based tests]");
    
    // Test 1: Submodule Semantic
    console.log(`\nRunning: Submodule Semantic Validation...`);
    const semanticResult = await testSubmoduleSemantic(
      options.renderImagePath!,
      subassembly,
      steps
    );
    results.push(semanticResult);
    printResult(semanticResult);
    
    // Test 2: Quick Component Check
    const subInfo = TEST_BLUEPRINT.subassemblies.find(
      s => s.name.toLowerCase() === subassembly.toLowerCase()
    );
    if (subInfo?.expected_components) {
      console.log(`\nRunning: Quick Component Check...`);
      const componentResult = await testQuickComponentCheck(
        options.renderImagePath!,
        subInfo.expected_components
      );
      results.push(componentResult);
      printResult(componentResult);
    }
  } else if (!hasSemanticAvailable) {
    console.log("\n[Skipping image-based tests - OpenAI API not configured]");
  } else {
    console.log("\n[Skipping image-based tests - no render image provided]");
  }
  
  // Tests requiring LDraw MPD (no image needed)
  if (hasMpd) {
    console.log("\n[MPD-based tests]");
    
    // Test 3: Structural Validation
    console.log(`\nRunning: Structural Validation...`);
    const structResult = testStructuralValidation(options.ldrawMpd!, "partial");
    results.push(structResult);
    printResult(structResult);
    
    // Test 4: Subassembly Position
    console.log(`\nRunning: Subassembly Position Validation...`);
    const posResult = testSubassemblyPosition(options.ldrawMpd!, subassembly);
    results.push(posResult);
    printResult(posResult);
    
    // Test 5: Symmetry Check
    console.log(`\nRunning: Symmetry Check...`);
    const symResult = testSymmetryCheck(options.ldrawMpd!, subassembly);
    results.push(symResult);
    printResult(symResult);
  } else {
    console.log("\n[Skipping MPD-based tests - no LDraw MPD provided]");
  }
  
  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("SUMMARY");
  console.log("=".repeat(70));
  
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed && !r.error).length;
  const errored = results.filter(r => r.error).length;
  const totalTime = results.reduce((sum, r) => sum + r.duration, 0);
  
  console.log(`Total tests: ${results.length}`);
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Errors:  ${errored}`);
  console.log(`Total time: ${totalTime}ms`);
  
  return results;
}

function printResult(result: IncrementalTestResult) {
  const status = result.error ? "ERROR" : result.passed ? "PASS" : "FAIL";
  const statusColor = result.error ? "\x1b[33m" : result.passed ? "\x1b[32m" : "\x1b[31m";
  const reset = "\x1b[0m";
  
  console.log(`  ${statusColor}[${status}]${reset} ${result.testName} (${result.duration}ms)`);
  
  if (result.error) {
    console.log(`         Error: ${result.error}`);
  } else if (!result.passed) {
    console.log(`         Details: ${JSON.stringify(result.details, null, 2).split("\n").join("\n         ")}`);
  } else if (result.details.summary) {
    console.log(`         ${result.details.summary}`);
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  
  let renderImagePath: string | undefined;
  let subassemblyName: string | undefined;
  let stepsCompleted = 6;
  
  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--subassembly" && args[i + 1]) {
      subassemblyName = args[i + 1];
      i++;
    } else if (args[i] === "--steps" && args[i + 1]) {
      stepsCompleted = parseInt(args[i + 1], 10);
      i++;
    } else if (!args[i].startsWith("--") && !renderImagePath) {
      renderImagePath = args[i];
    }
  }
  
  // Example MPD for testing (minimal valid partial MPD)
  const exampleMpd = `0 FILE model.ldr
0 BrickHero - Partial Build
0 Name: model.ldr
0 Author: LegoBuilder
0 !LDRAW_ORG Unofficial_Model
0 !LICENSE Redistributable under CCAL version 2.0 : see CAreadme.txt

0 STEP
1 4 0 0 0 1 0 0 0 1 0 0 0 1 3020.dat
0 STEP
1 4 0 -8 0 1 0 0 0 1 0 0 0 1 3020.dat
0 STEP
1 1 0 -16 0 1 0 0 0 1 0 0 0 1 3003.dat
0 STEP
1 1 0 -40 0 1 0 0 0 1 0 0 0 1 3003.dat
0 STEP
1 14 0 -64 0 1 0 0 0 1 0 0 0 1 3626.dat
0 NOFILE`;

  await runIncrementalTests({
    renderImagePath,
    ldrawMpd: exampleMpd,
    subassemblyName,
    stepsCompleted
  });
}

main().catch(console.error);
