#!/usr/bin/env npx ts-node
/**
 * FINAL-ONLY VALIDATION TESTS
 * 
 * These tests can ONLY run when the model is COMPLETE because they require:
 *   - The original reference image (to compare against)
 *   - The complete rendered model
 *   - All subassemblies present and connected
 * 
 * They validate:
 *   - Reference image similarity (does it look like the input?)
 *   - Full blueprint compliance (all subassemblies present and positioned)
 *   - Overall structural integrity
 *   - Cross-subassembly connections
 * 
 * Usage:
 *   npx ts-node scripts/test-final-validation.ts <reference_image> <render_image> [--mpd <mpd_file>]
 * 
 * Example:
 *   npx ts-node scripts/test-final-validation.ts ./input.png ./render.png --mpd ./model.mpd
 */

import path from "path";
import fs from "fs";
import { config } from "dotenv";

// Load environment
config({ path: path.join(process.cwd(), ".env.local") });

import {
  validateSemanticSimilarity,
  validateFinalModelSemantic,
  isSemanticValidationAvailable,
  FINAL_ONLY_VALIDATIONS,
  type Blueprint,
  type FinalSemanticResult
} from "../src/lib/semanticValidator";
import { validateRender, type BlueprintInfo } from "../src/lib/renderValidation";
import { compareImages } from "../src/lib/imageSimilarity";

// ============================================================================
// Test Configuration
// ============================================================================

// Example blueprint for testing
const TEST_BLUEPRINT: Blueprint = {
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
// Final-Only Test Functions
// ============================================================================

interface FinalTestResult {
  testName: string;
  passed: boolean;
  duration: number;
  score?: number;
  details: Record<string, unknown>;
  error?: string;
}

/**
 * Test 1: Reference Image Semantic Similarity
 * 
 * The primary final validation - compares the rendered model against
 * the original reference image to ensure it captures the essence.
 * 
 * REQUIRES: Both reference image and complete render
 */
async function testReferenceImageSimilarity(
  referenceImagePath: string,
  renderImagePath: string
): Promise<FinalTestResult> {
  const testName = "Reference Image Semantic Similarity";
  const start = Date.now();
  
  try {
    const result = await validateSemanticSimilarity(referenceImagePath, renderImagePath);
    
    return {
      testName,
      passed: result.isValid,
      duration: Date.now() - start,
      score: result.similarityScore,
      details: {
        similarityScore: result.similarityScore,
        overallMatch: result.overallMatch,
        componentsExpected: result.components.expected,
        componentsFound: result.components.found,
        componentsMissing: result.components.missing,
        componentsMisplaced: result.components.misplaced,
        proportions: result.proportions,
        orientation: result.orientation,
        issues: result.issues,
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
 * Test 2: Comprehensive Final Model Validation
 * 
 * Uses both reference image AND blueprint to validate the complete model.
 * This is the most thorough validation available.
 * 
 * REQUIRES: Reference image, render, and blueprint
 */
async function testFinalModelComprehensive(
  referenceImagePath: string,
  renderImagePath: string,
  blueprint: Blueprint
): Promise<FinalTestResult> {
  const testName = "Comprehensive Final Model Validation";
  const start = Date.now();
  
  try {
    const result = await validateFinalModelSemantic(
      referenceImagePath,
      renderImagePath,
      blueprint
    );
    
    return {
      testName,
      passed: result.isValid,
      duration: Date.now() - start,
      score: result.overallScore,
      details: {
        overallScore: result.overallScore,
        overallMatch: result.overallMatch,
        referenceMatch: result.referenceMatch,
        blueprintCompliance: result.blueprintCompliance,
        buildQuality: result.buildQuality,
        proportions: result.proportions,
        issues: result.issues,
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
 * Test 3: Blueprint Compliance Check
 * 
 * Validates that all subassemblies defined in the blueprint are:
 * - Present in the final model
 * - In their expected positions
 * - Properly connected
 * 
 * REQUIRES: Complete MPD and blueprint
 */
function testBlueprintCompliance(
  ldrawMpd: string,
  blueprint: Blueprint
): FinalTestResult {
  const testName = "Blueprint Compliance";
  const start = Date.now();
  
  try {
    const result = validateRender({
      ldraw_mpd: ldrawMpd,
      mode: "full",
      do_render_comparison: false,
      blueprint: blueprint as unknown as BlueprintInfo
    });
    
    const subassemblyResults = result.subassemblies?.results ?? [];
    const allPresent = subassemblyResults.every(s => s.valid);
    const positionIssues = subassemblyResults.filter(s => 
      s.position && !s.position.attachment_valid
    );
    
    return {
      testName,
      passed: result.subassemblies?.valid ?? false,
      duration: Date.now() - start,
      details: {
        subassemblyResults: subassemblyResults.map(s => ({
          name: s.name,
          valid: s.valid,
          position: s.position?.relative_to_model,
          positionValid: s.position?.attachment_valid,
          issues: s.issues
        })),
        allSubassembliesPresent: allPresent,
        positionIssues: positionIssues.map(s => s.name),
        overallIssues: result.subassemblies?.issues
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
 * Test 4: Pixel-Level Image Similarity (SSIM)
 * 
 * Compares the rendered image to reference using structural similarity.
 * This is a quantitative complement to the semantic comparison.
 * 
 * REQUIRES: Both reference and render images
 */
function testImageSimilaritySSIM(
  referenceImagePath: string,
  renderImagePath: string,
  minSimilarity: number = 60
): FinalTestResult {
  const testName = "Image Similarity (SSIM)";
  const start = Date.now();
  
  try {
    const result = compareImages(renderImagePath, referenceImagePath);
    
    return {
      testName,
      passed: result.overall >= minSimilarity,
      duration: Date.now() - start,
      score: result.overall,
      details: {
        overallScore: result.overall,
        passThreshold: minSimilarity,
        ssim: result.metrics.ssim,
        mse: result.metrics.mse,
        psnr: result.metrics.psnr,
        method: result.details?.method
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
 * Test 5: Full Structural Validation
 * 
 * Complete structural check of the final MPD.
 * 
 * REQUIRES: Complete MPD
 */
function testFullStructuralValidation(
  ldrawMpd: string,
  referenceImagePath?: string,
  minSimilarity: number = 60
): FinalTestResult {
  const testName = "Full Structural Validation";
  const start = Date.now();
  
  try {
    const result = validateRender({
      ldraw_mpd: ldrawMpd,
      mode: "full",
      reference_image_path: referenceImagePath,
      do_render_comparison: !!referenceImagePath,
      min_similarity: minSimilarity
    });
    
    return {
      testName,
      passed: result.valid,
      duration: Date.now() - start,
      score: result.similarity?.score,
      details: {
        structureValid: result.structure.valid,
        continuityValid: result.continuity.valid,
        similarityScore: result.similarity?.score,
        similarityPasses: result.similarity?.passes_threshold,
        partCount: result.meta.ldraw_part_count,
        checksRun: result.meta.checks_run,
        structureIssues: result.structure.issues.filter(i => i.severity === "error"),
        continuityIssues: result.continuity.issues.filter(i => i.severity === "error"),
        failureReason: result.failure_reason
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
 * Test 6: Cross-Subassembly Connection Validation
 * 
 * Validates that subassemblies are properly connected to each other.
 * Checks for floating subassemblies or gaps between sections.
 * 
 * REQUIRES: Complete MPD with all subassemblies
 */
function testCrossSubassemblyConnections(
  ldrawMpd: string,
  blueprint: Blueprint
): FinalTestResult {
  const testName = "Cross-Subassembly Connections";
  const start = Date.now();
  
  try {
    // Run full validation with blueprint
    const result = validateRender({
      ldraw_mpd: ldrawMpd,
      mode: "full",
      do_render_comparison: false,
      blueprint: blueprint as unknown as BlueprintInfo
    });
    
    // Analyze continuity issues that span subassemblies
    const continuityIssues = result.continuity.issues;
    const isolatedParts = continuityIssues.filter(i => 
      i.message.toLowerCase().includes("isolated") ||
      i.message.toLowerCase().includes("no neighbor")
    );
    
    // Check if any subassembly has parts that are too far from others
    const subResults = result.subassemblies?.results ?? [];
    const disconnectedSubs: string[] = [];
    
    for (let i = 0; i < subResults.length; i++) {
      for (let j = i + 1; j < subResults.length; j++) {
        const sub1 = subResults[i];
        const sub2 = subResults[j];
        
        // Check if these should be connected based on blueprint
        const shouldConnect = shouldSubassembliesConnect(
          sub1.name, sub2.name, blueprint
        );
        
        if (shouldConnect && sub1.bounds && sub2.bounds) {
          // Simple distance check between bounding box centers
          const dx = Math.abs(sub1.bounds.center.x - sub2.bounds.center.x);
          const dy = Math.abs(sub1.bounds.center.y - sub2.bounds.center.y);
          const dz = Math.abs(sub1.bounds.center.z - sub2.bounds.center.z);
          const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
          
          // If distance is very large, they might not be connected
          const maxExpectedDist = 200; // LDU - about 5 bricks
          if (dist > maxExpectedDist) {
            disconnectedSubs.push(`${sub1.name} <-> ${sub2.name}`);
          }
        }
      }
    }
    
    const hasConnectionIssues = isolatedParts.length > 0 || disconnectedSubs.length > 0;
    
    return {
      testName,
      passed: !hasConnectionIssues,
      duration: Date.now() - start,
      details: {
        isolatedParts: isolatedParts.length,
        disconnectedSubassemblies: disconnectedSubs,
        subassemblyBounds: subResults.map(s => ({
          name: s.name,
          center: s.bounds?.center
        })),
        continuityIssues
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
 * Helper: Determine if two subassemblies should be connected
 */
function shouldSubassembliesConnect(
  sub1Name: string,
  sub2Name: string,
  blueprint: Blueprint
): boolean {
  // Define expected connections
  const connections: Record<string, string[]> = {
    "base": ["legs"],
    "legs": ["base", "torso"],
    "torso": ["legs", "arms", "head"],
    "arms": ["torso"],
    "head": ["torso"]
  };
  
  const s1 = sub1Name.toLowerCase();
  const s2 = sub2Name.toLowerCase();
  
  return connections[s1]?.includes(s2) || connections[s2]?.includes(s1);
}

// ============================================================================
// Test Runner
// ============================================================================

async function runFinalTests(options: {
  referenceImagePath: string;
  renderImagePath: string;
  ldrawMpd?: string;
  minSimilarity?: number;
}) {
  console.log("=".repeat(70));
  console.log("FINAL-ONLY VALIDATION TESTS");
  console.log("These tests require the COMPLETE model and reference image");
  console.log("=".repeat(70));
  console.log();
  
  console.log("Final-only validations:");
  FINAL_ONLY_VALIDATIONS.forEach(v => console.log(`  - ${v}`));
  console.log();
  
  const results: FinalTestResult[] = [];
  const minSim = options.minSimilarity ?? 60;
  
  // Check prerequisites
  const hasReference = fs.existsSync(options.referenceImagePath);
  const hasRender = fs.existsSync(options.renderImagePath);
  const hasMpd = !!options.ldrawMpd;
  const hasSemanticAvailable = isSemanticValidationAvailable();
  
  console.log("Test Configuration:");
  console.log(`  Reference image: ${hasReference ? options.referenceImagePath : "NOT FOUND"}`);
  console.log(`  Render image: ${hasRender ? options.renderImagePath : "NOT FOUND"}`);
  console.log(`  Has LDraw MPD: ${hasMpd}`);
  console.log(`  Min similarity threshold: ${minSim}%`);
  console.log(`  Semantic validation available: ${hasSemanticAvailable}`);
  console.log();
  
  if (!hasReference || !hasRender) {
    console.error("ERROR: Final validation requires both reference and render images");
    process.exit(1);
  }
  
  console.log("-".repeat(70));
  console.log("Running Tests...");
  console.log("-".repeat(70));
  
  // Test 1: Reference Image Semantic Similarity
  if (hasSemanticAvailable) {
    console.log("\n[Semantic Tests]");
    
    console.log(`\nRunning: Reference Image Semantic Similarity...`);
    const refResult = await testReferenceImageSimilarity(
      options.referenceImagePath,
      options.renderImagePath
    );
    results.push(refResult);
    printResult(refResult);
    
    // Test 2: Comprehensive Final Model Validation
    console.log(`\nRunning: Comprehensive Final Model Validation...`);
    const compResult = await testFinalModelComprehensive(
      options.referenceImagePath,
      options.renderImagePath,
      TEST_BLUEPRINT
    );
    results.push(compResult);
    printResult(compResult);
  } else {
    console.log("\n[Skipping semantic tests - OpenAI API not configured]");
  }
  
  // Test 4: Pixel-Level Similarity
  console.log("\n[Image Comparison Tests]");
  
  console.log(`\nRunning: Image Similarity (SSIM)...`);
  const ssimResult = testImageSimilaritySSIM(
    options.referenceImagePath,
    options.renderImagePath,
    minSim
  );
  results.push(ssimResult);
  printResult(ssimResult);
  
  // MPD-based tests
  if (hasMpd) {
    console.log("\n[MPD-Based Tests]");
    
    // Test 3: Blueprint Compliance
    console.log(`\nRunning: Blueprint Compliance...`);
    const bpResult = testBlueprintCompliance(options.ldrawMpd!, TEST_BLUEPRINT);
    results.push(bpResult);
    printResult(bpResult);
    
    // Test 5: Full Structural Validation
    console.log(`\nRunning: Full Structural Validation...`);
    const structResult = testFullStructuralValidation(
      options.ldrawMpd!,
      options.referenceImagePath,
      minSim
    );
    results.push(structResult);
    printResult(structResult);
    
    // Test 6: Cross-Subassembly Connections
    console.log(`\nRunning: Cross-Subassembly Connections...`);
    const connResult = testCrossSubassemblyConnections(options.ldrawMpd!, TEST_BLUEPRINT);
    results.push(connResult);
    printResult(connResult);
  } else {
    console.log("\n[Skipping MPD-based tests - no LDraw MPD provided]");
    console.log("  Provide --mpd <file> to run full structural tests");
  }
  
  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("SUMMARY");
  console.log("=".repeat(70));
  
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed && !r.error).length;
  const errored = results.filter(r => r.error).length;
  const totalTime = results.reduce((sum, r) => sum + r.duration, 0);
  
  // Calculate average score for tests that have scores
  const scoredTests = results.filter(r => r.score !== undefined);
  const avgScore = scoredTests.length > 0
    ? scoredTests.reduce((sum, r) => sum + (r.score ?? 0), 0) / scoredTests.length
    : null;
  
  console.log(`Total tests: ${results.length}`);
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Errors:  ${errored}`);
  if (avgScore !== null) {
    console.log(`Average score: ${avgScore.toFixed(1)}%`);
  }
  console.log(`Total time: ${totalTime}ms`);
  
  // Overall verdict
  console.log();
  const overallPass = passed === results.length;
  if (overallPass) {
    console.log("\x1b[32m✓ FINAL VALIDATION PASSED\x1b[0m");
  } else {
    console.log("\x1b[31m✗ FINAL VALIDATION FAILED\x1b[0m");
    if (failed > 0) {
      console.log(`  ${failed} test(s) failed`);
    }
    if (errored > 0) {
      console.log(`  ${errored} test(s) had errors`);
    }
  }
  
  return results;
}

function printResult(result: FinalTestResult) {
  const status = result.error ? "ERROR" : result.passed ? "PASS" : "FAIL";
  const statusColor = result.error ? "\x1b[33m" : result.passed ? "\x1b[32m" : "\x1b[31m";
  const reset = "\x1b[0m";
  
  let scoreStr = "";
  if (result.score !== undefined) {
    scoreStr = ` [Score: ${result.score.toFixed(1)}%]`;
  }
  
  console.log(`  ${statusColor}[${status}]${reset} ${result.testName}${scoreStr} (${result.duration}ms)`);
  
  if (result.error) {
    console.log(`         Error: ${result.error}`);
  } else if (!result.passed && result.details.summary) {
    console.log(`         ${result.details.summary}`);
  } else if (!result.passed && result.details.failureReason) {
    console.log(`         Failure: ${result.details.failureReason}`);
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log("Usage: npx ts-node scripts/test-final-validation.ts <reference_image> <render_image> [options]");
    console.log();
    console.log("Options:");
    console.log("  --mpd <file>        Path to LDraw MPD file for structural tests");
    console.log("  --min-similarity N  Minimum similarity threshold (default: 60)");
    console.log();
    console.log("Example:");
    console.log("  npx ts-node scripts/test-final-validation.ts ./input.png ./render.png --mpd ./model.mpd");
    process.exit(1);
  }
  
  let referenceImagePath = args[0];
  let renderImagePath = args[1];
  let ldrawMpd: string | undefined;
  let minSimilarity = 60;
  
  // Parse options
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--mpd" && args[i + 1]) {
      const mpdPath = args[i + 1];
      if (fs.existsSync(mpdPath)) {
        ldrawMpd = fs.readFileSync(mpdPath, "utf8");
      } else {
        console.error(`MPD file not found: ${mpdPath}`);
        process.exit(1);
      }
      i++;
    } else if (args[i] === "--min-similarity" && args[i + 1]) {
      minSimilarity = parseInt(args[i + 1], 10);
      i++;
    }
  }
  
  await runFinalTests({
    referenceImagePath,
    renderImagePath,
    ldrawMpd,
    minSimilarity
  });
}

main().catch(console.error);
