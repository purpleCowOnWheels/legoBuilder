#!/usr/bin/env tsx
/**
 * Test script for LDraw validation tools.
 * Tests structure validation and prepares for LDInspector integration.
 */

import { 
  validateLDrawMpdOrThrow,
  validateLDrawStructure,
  runLDInspector
} from "../src/lib/ldrawValidate";
import path from "node:path";
import fs from "node:fs";

console.log("=== LDraw Validation Test ===\n");

// Find test MPD files
const ldrawDir = path.join(process.cwd(), "data", "ldraw");
const mpdFiles = fs.readdirSync(ldrawDir)
  .filter(f => f.endsWith(".mpd"))
  .filter(f => f.startsWith("manual_")); // Use the manually generated ones

if (mpdFiles.length === 0) {
  console.error("No manual MPD files found in data/ldraw/");
  console.log("Run: npx tsx scripts/generate-manual.ts <path-to-mpd> first");
  process.exit(1);
}

console.log(`Found ${mpdFiles.length} MPD files to test`);
console.log(`Testing with: ${mpdFiles[0]}\n`);

const testFile = path.join(ldrawDir, mpdFiles[0]);
const mpdContent = fs.readFileSync(testFile, "utf-8");

// Test 1: Basic syntax validation
console.log("1. Testing basic syntax validation...");
try {
  validateLDrawMpdOrThrow(mpdContent);
  console.log("   ✓ Basic syntax validation passed\n");
} catch (error) {
  console.error("   ✗ Validation failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}

// Test 2: Structural validation
console.log("2. Testing structural validation...");
const structResult = validateLDrawStructure(mpdContent);
console.log(`   Valid: ${structResult.isValid ? "✓" : "✗"}`);
console.log(`   Issues found: ${structResult.issues.length}`);

if (structResult.issues.length > 0) {
  console.log("\n   Issues:");
  for (const issue of structResult.issues.slice(0, 5)) {
    console.log(`   - [${issue.severity}] ${issue.type}: ${issue.message}`);
  }
  if (structResult.issues.length > 5) {
    console.log(`   ... and ${structResult.issues.length - 5} more`);
  }
}
console.log();

// Test 3: LDInspector (if available)
console.log("3. Testing LDInspector integration...");
try {
  const inspectorResult = runLDInspector(testFile, {
    checkCollisions: true,
    checkConnections: false,
    timeout: 30000
  });
  
  if (inspectorResult.rawOutput?.includes("not available")) {
    console.log("   ⚠️  LDInspector not installed");
    console.log("   Download from: https://fam-frenz.de/stefan/ldi.html");
    console.log("   Or set LDINSPECTOR_BIN environment variable");
  } else {
    console.log(`   Valid: ${inspectorResult.isValid ? "✓" : "✗"}`);
    console.log(`   Issues found: ${inspectorResult.issues.length}`);
    
    if (inspectorResult.issues.length > 0) {
      console.log("\n   Issues:");
      for (const issue of inspectorResult.issues.slice(0, 5)) {
        console.log(`   - [${issue.severity}] ${issue.type}: ${issue.message}`);
      }
      if (inspectorResult.issues.length > 5) {
        console.log(`   ... and ${inspectorResult.issues.length - 5} more`);
      }
    }
  }
} catch (error) {
  console.log("   ⚠️  LDInspector test skipped:", error instanceof Error ? error.message : String(error));
}
console.log();

// Test 4: Test all manual MPD files
console.log("4. Testing all manual MPD files...");
let passCount = 0;
let failCount = 0;

for (const file of mpdFiles) {
  const filePath = path.join(ldrawDir, file);
  const content = fs.readFileSync(filePath, "utf-8");
  
  try {
    validateLDrawMpdOrThrow(content);
    const structResult = validateLDrawStructure(content);
    
    if (structResult.isValid) {
      console.log(`   ✓ ${file}`);
      passCount++;
    } else {
      console.log(`   ⚠️  ${file} - ${structResult.issues.length} issues`);
      passCount++; // Still passes basic validation
    }
  } catch (error) {
    console.error(`   ✗ ${file} - ${error instanceof Error ? error.message : String(error)}`);
    failCount++;
  }
}

console.log();
console.log(`Results: ${passCount} passed, ${failCount} failed`);

if (failCount > 0) {
  console.log("\n❌ Some validations failed");
  process.exit(1);
}

console.log("\n=== All Tests Passed ===");
console.log("\nValidation tools ready:");
console.log("  ✓ Basic syntax validation");
console.log("  ✓ Structural validation");
console.log("  ⚠️  LDInspector (install separately for collision detection)");
