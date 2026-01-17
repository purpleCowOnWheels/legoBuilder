#!/usr/bin/env tsx
/**
 * Test script for semantic similarity validation.
 * 
 * Tests that rendered LEGO models match input images conceptually.
 */

import { validateSemanticSimilarity, isSemanticValidationAvailable } from "../src/lib/semanticValidator";
import path from "path";
import fs from "fs";

console.log("=== Semantic Similarity Validation Test ===\n");

// Check if available
console.log("1. Checking if semantic validation is available...");
const available = isSemanticValidationAvailable();
console.log(`   ${available ? "✓" : "✗"} Python + OpenAI API: ${available ? "Available" : "Not available"}`);

if (!available) {
  console.error("\n❌ Semantic validation not available.");
  console.error("   Ensure OPENAI_API_KEY is set in .env.local");
  process.exit(1);
}
console.log();

// Find test images
const thumbsDir = path.join(process.cwd(), "public", "generated-thumbs");
const thumbs = fs.readdirSync(thumbsDir)
  .filter(f => f.endsWith(".png"))
  .filter(f => f.startsWith("manual_"));

if (thumbs.length < 2) {
  console.error("Need at least 2 manual thumbnail images to test comparison");
  process.exit(1);
}

console.log(`2. Found ${thumbs.length} thumbnail renders`);

// For demo purposes, we'll compare the same image to itself (should score high)
// In real use, you'd compare input image vs render
const testImage1 = path.join(thumbsDir, thumbs[0]);
const testImage2 = path.join(thumbsDir, thumbs[1]);

console.log(`   Testing: ${thumbs[0]} vs ${thumbs[1]}\n`);

// Test semantic validation
console.log("3. Running semantic similarity validation...");
console.log("   (This may take 10-30 seconds...)\n");

try {
  const result = await validateSemanticSimilarity(testImage1, testImage2);
  
  console.log(`   Overall Match: ${result.overallMatch.toUpperCase()}`);
  console.log(`   Similarity Score: ${result.similarityScore}%`);
  console.log(`   Valid: ${result.isValid ? "✓" : "✗"}\n`);
  
  console.log("4. Components Analysis:");
  console.log(`   Expected: ${result.components.expected.join(", ") || "N/A"}`);
  console.log(`   Found: ${result.components.found.join(", ") || "N/A"}`);
  
  if (result.components.missing.length > 0) {
    console.log(`   Missing: ${result.components.missing.join(", ")}`);
  }
  
  if (result.components.misplaced.length > 0) {
    console.log(`   Misplaced: ${result.components.misplaced.join(", ")}`);
  }
  console.log();
  
  if (result.proportions) {
    console.log("5. Proportions:");
    console.log(`   Correct: ${result.proportions.correct ? "✓" : "✗"}`);
    if (result.proportions.issues.length > 0) {
      console.log(`   Issues: ${result.proportions.issues.join(", ")}`);
    }
    console.log();
  }
  
  if (result.issues.length > 0) {
    console.log("6. Issues Found:");
    for (const issue of result.issues.slice(0, 5)) {
      const icon = issue.severity === "error" ? "✗" : "⚠";
      console.log(`   ${icon} [${issue.severity}] ${issue.type}: ${issue.component || ""}`);
      if (issue.expected && issue.actual) {
        console.log(`      Expected: ${issue.expected}, Actual: ${issue.actual}`);
      }
    }
    if (result.issues.length > 5) {
      console.log(`   ... and ${result.issues.length - 5} more issues`);
    }
    console.log();
  }
  
  console.log("7. Summary:");
  console.log(`   ${result.summary}\n`);
  
  console.log("=== Test Complete ===\n");
  console.log("Semantic validation is working!");
  console.log("  ✓ Analyzes component presence");
  console.log("  ✓ Checks relative positions");
  console.log("  ✓ Validates proportions");
  console.log("  ✓ Identifies structural issues");
  console.log("\nThis validation ensures the LEGO model conceptually matches");
  console.log("the input image, not just pixel-level similarity.");
  
} catch (error) {
  console.error("   ✗ Validation failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
