#!/usr/bin/env npx tsx
/**
 * Test script for the unified render validation module.
 * 
 * Usage:
 *   npx tsx scripts/test-render-validation.ts
 *   npx tsx scripts/test-render-validation.ts /path/to/model.mpd /path/to/reference.png
 */

import fs from "node:fs";
import path from "node:path";
import { validateRender, validateRenderForToolLoop, type RenderValidationInput, type BlueprintInfo } from "../src/lib/renderValidation";

const SAMPLE_VALID_MPD = `0 FILE model.ldr
0 Untitled Model
0 Name: model.ldr
0 Author: LegoBuilder
0 !LDRAW_ORG Model
0 !LICENSE Redistributable under CCAL version 2.0 : see CAreadme.txt

1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat
0 STEP
1 4 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat
0 STEP
1 1 0 -48 0 1 0 0 0 1 0 0 0 1 3003.dat
0 NOFILE
`;

const SAMPLE_INVALID_MPD = `0 FILE model.ldr
1 4 NaN 0 0 1 0 0 0 1 0 0 0 1 3001.dat
0 NOFILE
`;

const SAMPLE_CHUNK = `1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat
0 STEP
1 4 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat
`;

const SAMPLE_ISOLATED_PARTS = `0 FILE model.ldr
1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat
1 4 1000 1000 1000 1 0 0 0 1 0 0 0 1 3001.dat
0 NOFILE
`;

// MPD with clear subassemblies (base at bottom, body in center, wings on sides)
const SAMPLE_WITH_SUBASSEMBLIES = `0 FILE model.ldr
0 Spaceship Model
0 Name: model.ldr

0 // Step 1-2: Base (bottom)
1 4 0 24 0 1 0 0 0 1 0 0 0 1 3020.dat
1 4 40 24 0 1 0 0 0 1 0 0 0 1 3020.dat
0 STEP
1 4 0 24 40 1 0 0 0 1 0 0 0 1 3020.dat
0 STEP

0 // Step 3-4: Body (center)
1 1 20 0 20 1 0 0 0 1 0 0 0 1 3001.dat
0 STEP
1 1 20 -24 20 1 0 0 0 1 0 0 0 1 3001.dat
0 STEP

0 // Step 5-6: Wings (left and right sides)
1 2 -60 0 20 1 0 0 0 1 0 0 0 1 3039.dat
0 STEP
1 2 100 0 20 1 0 0 0 1 0 0 0 1 3039.dat

0 NOFILE
`;

// MPD with wrong subassembly positions (wings at bottom instead of sides)
const SAMPLE_WRONG_POSITIONS = `0 FILE model.ldr
0 Spaceship Model

0 // Step 1-2: Base
1 4 0 24 0 1 0 0 0 1 0 0 0 1 3020.dat
0 STEP
1 4 40 24 0 1 0 0 0 1 0 0 0 1 3020.dat
0 STEP

0 // Step 3-4: Body
1 1 20 0 20 1 0 0 0 1 0 0 0 1 3001.dat
0 STEP
1 1 20 -24 20 1 0 0 0 1 0 0 0 1 3001.dat
0 STEP

0 // Step 5-6: Wings (WRONG - at bottom instead of sides)
1 2 20 48 20 1 0 0 0 1 0 0 0 1 3039.dat
0 STEP
1 2 20 48 60 1 0 0 0 1 0 0 0 1 3039.dat

0 NOFILE
`;

const SAMPLE_BLUEPRINT: BlueprintInfo = {
  subassemblies: [
    { name: "base", description: "Foundation plates", expected_position: "bottom" },
    { name: "body", description: "Main fuselage", expected_position: "center" },
    { name: "wings", description: "Side wings", expected_position: "left", symmetric: true }
  ],
  step_outline: [
    { step: 1, title: "Base foundation", description: "Start with base plates", subassembly: "base" },
    { step: 2, title: "Base extension", description: "Add more base", subassembly: "base" },
    { step: 3, title: "Body start", description: "Begin body", subassembly: "body" },
    { step: 4, title: "Body stack", description: "Stack body", subassembly: "body" },
    { step: 5, title: "Left wing", description: "Attach left wing", subassembly: "wings" },
    { step: 6, title: "Right wing", description: "Attach right wing", subassembly: "wings" }
  ]
};

function printResult(name: string, result: ReturnType<typeof validateRender>) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`TEST: ${name}`);
  console.log("=".repeat(60));
  
  console.log(`\n  Valid: ${result.valid ? "✅ YES" : "❌ NO"}`);
  if (result.failure_reason) {
    console.log(`  Reason: ${result.failure_reason}`);
  }
  
  console.log(`\n  Structure: ${result.structure.valid ? "✅" : "❌"}`);
  if (result.structure.issues.length > 0) {
    for (const issue of result.structure.issues) {
      console.log(`    [${issue.severity}] ${issue.type}: ${issue.message}`);
    }
  }
  
  console.log(`  Continuity: ${result.continuity.valid ? "✅" : "❌"}`);
  if (result.continuity.issues.length > 0) {
    for (const issue of result.continuity.issues) {
      console.log(`    [${issue.severity}] ${issue.type}: ${issue.message}`);
    }
  }
  
  if (result.similarity) {
    console.log(`  Similarity: ${result.similarity.score}% (threshold: ${result.similarity.threshold}%) ${result.similarity.passes_threshold ? "✅" : "❌"}`);
    console.log(`    Method: ${result.similarity.method}`);
    if (result.similarity.metrics?.ssim !== undefined) {
      console.log(`    SSIM: ${result.similarity.metrics.ssim.toFixed(4)}`);
    }
  }
  
  if (result.subassemblies) {
    console.log(`  Subassemblies: ${result.subassemblies.valid ? "✅" : "❌"} (${result.subassemblies.results.length} checked)`);
    if (result.subassemblies.issues.length > 0) {
      for (const issue of result.subassemblies.issues) {
        console.log(`    [${issue.severity}] ${issue.type}: ${issue.message}`);
      }
    }
  }
  
  console.log(`\n  Meta:`);
  console.log(`    Duration: ${result.meta.duration_ms}ms`);
  console.log(`    Checks: ${result.meta.checks_run.join(", ")}`);
  console.log(`    Parts: ${result.meta.ldraw_part_count}`);
  console.log(`    Lines: ${result.meta.ldraw_line_count}`);
}

async function main() {
  const args = process.argv.slice(2);
  
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║         RENDER VALIDATION MODULE TEST                      ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  
  // Test 1: Valid MPD (full mode)
  printResult("Valid MPD (full mode)", validateRender({
    ldraw_mpd: SAMPLE_VALID_MPD,
    mode: "full"
  }));
  
  // Test 2: Invalid MPD (NaN coordinates)
  printResult("Invalid MPD (NaN coordinates)", validateRender({
    ldraw_mpd: SAMPLE_INVALID_MPD,
    mode: "full"
  }));
  
  // Test 3: Chunk mode
  printResult("Chunk mode (body only)", validateRender({
    ldraw_mpd: SAMPLE_CHUNK,
    mode: "chunk",
    step_from: 1,
    step_to: 2
  }));
  
  // Test 4: Isolated parts (continuity warning)
  printResult("Isolated parts (continuity)", validateRender({
    ldraw_mpd: SAMPLE_ISOLATED_PARTS,
    mode: "full"
  }));
  
  // Test 5: Subassembly validation (correct positions)
  const subResult1 = validateRender({
    ldraw_mpd: SAMPLE_WITH_SUBASSEMBLIES,
    mode: "full",
    blueprint: SAMPLE_BLUEPRINT
  });
  printResult("Subassemblies (correct positions)", subResult1);
  
  if (subResult1.subassemblies) {
    console.log("\n  Subassembly Details:");
    for (const sub of subResult1.subassemblies.results) {
      console.log(`    ${sub.name}: ${sub.valid ? "✅" : "❌"}`);
      if (sub.position) {
        console.log(`      Position: ${sub.position.relative_to_model} (valid: ${sub.position.attachment_valid})`);
      }
      if (sub.bounds) {
        console.log(`      Center: (${sub.bounds.center.x.toFixed(0)}, ${sub.bounds.center.y.toFixed(0)}, ${sub.bounds.center.z.toFixed(0)})`);
      }
    }
  }
  
  // Test 6: Subassembly validation (wrong positions)
  const subResult2 = validateRender({
    ldraw_mpd: SAMPLE_WRONG_POSITIONS,
    mode: "full",
    blueprint: SAMPLE_BLUEPRINT
  });
  printResult("Subassemblies (wrong positions)", subResult2);
  
  if (subResult2.subassemblies) {
    console.log("\n  Subassembly Details:");
    for (const sub of subResult2.subassemblies.results) {
      console.log(`    ${sub.name}: ${sub.valid ? "✅" : "❌"}`);
      if (sub.position) {
        console.log(`      Position: ${sub.position.relative_to_model} (expected: ${SAMPLE_BLUEPRINT.subassemblies.find(s => s.name === sub.name)?.expected_position || "?"})`);
      }
      for (const issue of sub.issues) {
        console.log(`      [${issue.severity}] ${issue.message}`);
      }
    }
  }
  
  // Test 7: Tool loop format with subassemblies
  console.log(`\n${"=".repeat(60)}`);
  console.log("TEST: Tool Loop Format (with subassemblies)");
  console.log("=".repeat(60));
  const toolResult = validateRenderForToolLoop({
    ldraw_mpd: SAMPLE_WITH_SUBASSEMBLIES,
    mode: "full",
    blueprint: SAMPLE_BLUEPRINT
  });
  console.log("\n  Tool result:", JSON.stringify(toolResult, null, 2));
  
  // Test 6: Custom file if provided
  if (args.length >= 1 && fs.existsSync(args[0])) {
    const mpdPath = args[0];
    const mpdContent = fs.readFileSync(mpdPath, "utf8");
    const refPath = args[1];
    
    const input: RenderValidationInput = {
      ldraw_mpd: mpdContent,
      mode: "full",
      reference_image_path: refPath && fs.existsSync(refPath) ? refPath : undefined,
      min_similarity: 60
    };
    
    printResult(`Custom file: ${path.basename(mpdPath)}`, validateRender(input));
  }
  
  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("SUMMARY");
  console.log("=".repeat(60));
  console.log(`
The unified render validation module provides:

1. Structure Validation
   - FILE/NOFILE directives
   - Part placement lines
   - Invalid coordinates

2. Continuity Checks
   - Y-axis alignment (plate/brick heights)
   - X/Z stud grid alignment
   - Isolated parts detection
   - Extreme coordinate detection

3. Render Comparison (when reference image provided)
   - LPub3D/LDView rendering
   - SSIM similarity scoring
   - Threshold-based pass/fail

4. MCP-Ready Interface
   - JSON in, JSON out
   - Tool definition exported for MCP servers

Usage in tool loop:
  validateRenderForToolLoop({ ldraw_mpd, mode, reference_image_path })

Usage for full results:
  validateRender({ ldraw_mpd, mode, reference_image_path, min_similarity })
`);
}

main().catch(console.error);
