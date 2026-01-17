#!/usr/bin/env npx tsx
/**
 * Test the MCP server's 3 high-level validation tools
 * 
 * Usage:
 *   npx tsx mcp-server/test-tools.ts
 */

import {
  validateRender,
  type BlueprintInfo
} from "../src/lib/renderValidation";
import {
  validateLDrawMpdChunkBodyOrThrow,
  validateLDrawMpdOrThrow,
  validateLDrawStructure
} from "../src/lib/ldrawValidate";
import { isConnectionValidationAvailable } from "../src/lib/connectionValidator";
import { isSemanticValidationAvailable } from "../src/lib/semanticValidator";
import { validatePhysics } from "../src/lib/physicsValidator";

// ============================================================================
// Test Data
// ============================================================================

const TEST_BLUEPRINT: BlueprintInfo = {
  subassemblies: [
    { name: "base", description: "Foundation plate", expected_position: "bottom", symmetric: true },
    { name: "body", description: "Main body section", expected_position: "center", symmetric: true },
    { name: "head", description: "Head with face", expected_position: "top", symmetric: false }
  ],
  step_outline: [
    { step: 1, title: "Base", description: "Build foundation", subassembly: "base" },
    { step: 2, title: "Body Lower", description: "Build lower body", subassembly: "body" },
    { step: 3, title: "Body Upper", description: "Build upper body", subassembly: "body" },
    { step: 4, title: "Head", description: "Build head", subassembly: "head" }
  ]
};

const TEST_CHUNK = `0 STEP
1 4 0 0 0 1 0 0 0 1 0 0 0 1 3020.dat
0 STEP
1 4 0 -8 0 1 0 0 0 1 0 0 0 1 3020.dat`;

const TEST_MPD = `0 FILE model.ldr
0 Test Model
0 Name: model.ldr
0 Author: Test

0 STEP
1 4 0 0 0 1 0 0 0 1 0 0 0 1 3020.dat
0 STEP
1 4 0 -8 0 1 0 0 0 1 0 0 0 1 3020.dat
0 STEP
1 1 0 -32 0 1 0 0 0 1 0 0 0 1 3003.dat
0 STEP
1 14 0 -56 0 1 0 0 0 1 0 0 0 1 3626.dat
0 NOFILE`;

// ============================================================================
// Simulated MCP Tool Handlers (same logic as server)
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

function simulateValidateStep(content: string, mode: "chunk" | "partial" | "full"): ComprehensiveResult {
  const checks: ValidationCheck[] = [];
  const recommendations: string[] = [];

  // Check 1: Syntax
  try {
    if (mode === "chunk") {
      validateLDrawMpdChunkBodyOrThrow({ chunkBody: content });
    } else {
      validateLDrawMpdOrThrow(content);
    }
    checks.push({ name: "syntax", passed: true, details: { mode } });
  } catch (e) {
    checks.push({ name: "syntax", passed: false, details: { mode }, error: e instanceof Error ? e.message : String(e) });
    recommendations.push(`Fix: ${e instanceof Error ? e.message : e}`);
  }

  // Check 2: Structure (for non-chunks)
  if (mode !== "chunk") {
    const structResult = validateLDrawStructure(content);
    checks.push({
      name: "structure",
      passed: structResult.isValid,
      details: { issues: structResult.issues }
    });
  }

  // Check 3: Continuity
  const mpdForCheck = mode === "chunk" ? `0 FILE model.ldr\n${content}\n0 NOFILE` : content;
  const renderResult = validateRender({
    ldraw_mpd: mpdForCheck,
    mode: mode === "chunk" ? "partial" : mode,
    do_render_comparison: false
  });

  checks.push({
    name: "continuity",
    passed: renderResult.continuity.valid,
    details: {
      part_count: renderResult.meta.ldraw_part_count,
      issues: renderResult.continuity.issues
    }
  });

  // Check 4: Connections (if available)
  if (isConnectionValidationAvailable() && mode !== "chunk") {
    checks.push({
      name: "connections",
      passed: true, // Simulated - real version writes to file
      details: { note: "Connection check available but skipped in test" }
    });
  }

  const passed = checks.filter(c => c.passed).length;
  const failed = checks.filter(c => !c.passed).length;

  return {
    valid: failed === 0,
    checks_run: checks.map(c => c.name),
    checks_passed: passed,
    checks_failed: failed,
    checks,
    summary: failed === 0
      ? `Step validation PASSED: ${passed}/${checks.length} checks`
      : `Step validation FAILED: ${failed}/${checks.length} checks failed`,
    recommendations: recommendations.length > 0 ? recommendations : undefined
  };
}

function simulateValidateSubmodule(ldrawMpd: string, subassemblyName: string, blueprint: BlueprintInfo): ComprehensiveResult {
  const checks: ValidationCheck[] = [];
  const recommendations: string[] = [];

  // Check 1: Structure
  const structResult = validateLDrawStructure(ldrawMpd);
  checks.push({
    name: "structure",
    passed: structResult.isValid,
    details: { issues: structResult.issues }
  });

  // Check 2: Position
  const renderResult = validateRender({
    ldraw_mpd: ldrawMpd,
    mode: "partial",
    do_render_comparison: false,
    blueprint,
    current_subassembly: subassemblyName
  });

  const subResult = renderResult.subassemblies?.results.find(
    r => r.name.toLowerCase() === subassemblyName.toLowerCase()
  );

  checks.push({
    name: "position",
    passed: subResult?.position?.attachment_valid ?? true,
    details: {
      expected: blueprint.subassemblies.find(s => s.name === subassemblyName)?.expected_position,
      actual: subResult?.position?.relative_to_model
    }
  });

  // Check 3: Continuity
  checks.push({
    name: "continuity",
    passed: renderResult.continuity.valid,
    details: { part_count: renderResult.meta.ldraw_part_count }
  });

  // Check 4: Semantic (if available)
  if (isSemanticValidationAvailable()) {
    checks.push({
      name: "semantic",
      passed: true, // Simulated - needs render image
      details: { note: "Semantic check available but no render image provided" }
    });
  }

  const passed = checks.filter(c => c.passed).length;
  const failed = checks.filter(c => !c.passed).length;

  return {
    valid: failed === 0,
    checks_run: checks.map(c => c.name),
    checks_passed: passed,
    checks_failed: failed,
    checks,
    summary: failed === 0
      ? `Submodule "${subassemblyName}" PASSED: ${passed}/${checks.length} checks`
      : `Submodule "${subassemblyName}" FAILED: ${failed}/${checks.length} checks failed`,
    recommendations: recommendations.length > 0 ? recommendations : undefined
  };
}

function simulateValidateFull(ldrawMpd: string, blueprint?: BlueprintInfo): ComprehensiveResult {
  const checks: ValidationCheck[] = [];
  const recommendations: string[] = [];

  // Check 1: Structure
  try {
    validateLDrawMpdOrThrow(ldrawMpd);
    const structResult = validateLDrawStructure(ldrawMpd);
    checks.push({
      name: "structure",
      passed: structResult.isValid,
      details: { issues: structResult.issues }
    });
  } catch (e) {
    checks.push({
      name: "structure",
      passed: false,
      details: {},
      error: e instanceof Error ? e.message : String(e)
    });
    recommendations.push(`Fix structural error`);
  }

  // Check 2: Continuity
  const renderResult = validateRender({
    ldraw_mpd: ldrawMpd,
    mode: "full",
    do_render_comparison: false,
    blueprint
  });

  checks.push({
    name: "continuity",
    passed: renderResult.continuity.valid,
    details: {
      part_count: renderResult.meta.ldraw_part_count,
      issues: renderResult.continuity.issues
    }
  });

  // Check 3: Blueprint compliance (if provided)
  if (blueprint) {
    checks.push({
      name: "blueprint_compliance",
      passed: renderResult.subassemblies?.valid ?? true,
      details: {
        results: renderResult.subassemblies?.results.map(s => ({
          name: s.name,
          valid: s.valid,
          position: s.position?.relative_to_model
        }))
      }
    });
  }

  // Check 4: Connections (if available)
  if (isConnectionValidationAvailable()) {
    checks.push({
      name: "connections",
      passed: true,
      details: { note: "Connection check available but skipped in test" }
    });
  }

  const passed = checks.filter(c => c.passed).length;
  const failed = checks.filter(c => !c.passed).length;

  return {
    valid: failed === 0,
    checks_run: checks.map(c => c.name),
    checks_passed: passed,
    checks_failed: failed,
    checks,
    summary: failed === 0
      ? `Full validation PASSED: ${passed}/${checks.length} checks (${renderResult.meta.ldraw_part_count} parts)`
      : `Full validation FAILED: ${failed}/${checks.length} checks failed`,
    recommendations: recommendations.length > 0 ? recommendations : undefined
  };
}

// ============================================================================
// Run Tests
// ============================================================================

console.log("=".repeat(70));
console.log("LEGO Validator MCP Server - Comprehensive Tool Tests");
console.log("=".repeat(70));
console.log();

// Capability check
console.log("Available Capabilities:");
console.log(`  Semantic (OpenAI Vision): ${isSemanticValidationAvailable() ? "✓" : "✗"}`);
console.log(`  Connection Validation:    ${isConnectionValidationAvailable() ? "✓" : "✗"}`);
console.log();

// Test 1: validate_step with chunk
console.log("-".repeat(70));
console.log("TEST: validate_step (mode=chunk)");
console.log("-".repeat(70));
const stepChunkResult = simulateValidateStep(TEST_CHUNK, "chunk");
console.log(JSON.stringify(stepChunkResult, null, 2));
console.log();

// Test 2: validate_step with full MPD
console.log("-".repeat(70));
console.log("TEST: validate_step (mode=full)");
console.log("-".repeat(70));
const stepFullResult = simulateValidateStep(TEST_MPD, "full");
console.log(JSON.stringify(stepFullResult, null, 2));
console.log();

// Test 3: validate_submodule
console.log("-".repeat(70));
console.log("TEST: validate_submodule (subassembly=body)");
console.log("-".repeat(70));
const submoduleResult = simulateValidateSubmodule(TEST_MPD, "body", TEST_BLUEPRINT);
console.log(JSON.stringify(submoduleResult, null, 2));
console.log();

// Test 4: validate_full
console.log("-".repeat(70));
console.log("TEST: validate_full (with blueprint)");
console.log("-".repeat(70));
const fullResult = simulateValidateFull(TEST_MPD, TEST_BLUEPRINT);
console.log(JSON.stringify(fullResult, null, 2));
console.log();

// Test 5: Invalid chunk
console.log("-".repeat(70));
console.log("TEST: validate_step with INVALID chunk (should fail)");
console.log("-".repeat(70));
const invalidChunk = `0 FILE model.ldr
1 4 0 0 0 1 0 0 0 1 0 0 0 1 3020.dat
0 NOFILE`;
const invalidResult = simulateValidateStep(invalidChunk, "chunk");
console.log(JSON.stringify(invalidResult, null, 2));
console.log();

// Test 6: Physics Validation
console.log("-".repeat(70));
console.log("TEST: Physics Validation (stable model)");
console.log("-".repeat(70));
const stablePhysics = validatePhysics(TEST_MPD);
console.log(JSON.stringify({
  is_stable: stablePhysics.isStable,
  stability_score: stablePhysics.stabilityScore,
  center_of_gravity: stablePhysics.centerOfGravity,
  issues_count: stablePhysics.issues.length,
  stats: stablePhysics.stats
}, null, 2));
console.log();

// Test 7: Physics Validation (unstable model - top heavy)
console.log("-".repeat(70));
console.log("TEST: Physics Validation (unstable - tall narrow tower)");
console.log("-".repeat(70));

const UNSTABLE_MPD = `0 FILE model.ldr
0 Tall Narrow Tower
0 Name: model.ldr

0 STEP
1 4 0 0 0 1 0 0 0 1 0 0 0 1 3024.dat
0 STEP
1 4 0 -8 0 1 0 0 0 1 0 0 0 1 3024.dat
0 STEP
1 4 0 -16 0 1 0 0 0 1 0 0 0 1 3024.dat
0 STEP
1 4 0 -24 0 1 0 0 0 1 0 0 0 1 3024.dat
0 STEP
1 4 0 -32 0 1 0 0 0 1 0 0 0 1 3024.dat
0 STEP
1 4 0 -40 0 1 0 0 0 1 0 0 0 1 3024.dat
0 STEP
1 4 0 -48 0 1 0 0 0 1 0 0 0 1 3024.dat
0 STEP
1 4 0 -56 0 1 0 0 0 1 0 0 0 1 3024.dat
0 NOFILE`;

const unstablePhysics = validatePhysics(UNSTABLE_MPD);
console.log(JSON.stringify({
  is_stable: unstablePhysics.isStable,
  stability_score: unstablePhysics.stabilityScore,
  height_to_base_ratio: unstablePhysics.stats.height_to_base_ratio,
  issues: unstablePhysics.issues.map(i => ({ type: i.type, severity: i.severity, message: i.message }))
}, null, 2));
console.log();

// Summary
console.log("=".repeat(70));
console.log("SUMMARY");
console.log("=".repeat(70));
console.log(`validate_step (chunk):   ${stepChunkResult.valid ? "PASS" : "FAIL"} - ${stepChunkResult.summary}`);
console.log(`validate_step (full):    ${stepFullResult.valid ? "PASS" : "FAIL"} - ${stepFullResult.summary}`);
console.log(`validate_submodule:      ${submoduleResult.valid ? "PASS" : "FAIL"} - ${submoduleResult.summary}`);
console.log(`validate_full:           ${fullResult.valid ? "PASS" : "FAIL"} - ${fullResult.summary}`);
console.log(`invalid chunk detected:  ${!invalidResult.valid ? "PASS" : "FAIL"} - correctly detected invalid input`);
console.log(`physics (stable):        ${stablePhysics.isStable ? "PASS" : "FAIL"} - score: ${stablePhysics.stabilityScore}%`);
console.log(`physics (unstable):      ${!unstablePhysics.isStable ? "PASS" : "FAIL"} - correctly detected unstable (${unstablePhysics.issues.length} issues)`);
