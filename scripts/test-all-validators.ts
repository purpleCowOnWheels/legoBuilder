#!/usr/bin/env npx tsx
/**
 * Test all validators on a pair of images
 */

import { config } from "dotenv";
import path from "node:path";
config({ path: path.join(process.cwd(), ".env.local") });

import fs from "node:fs";
import { compareImages, checkImageComparisonTools } from "../src/lib/imageSimilarity";
import { validateLegoConnections, isConnectionValidationAvailable } from "../src/lib/connectionValidator";
import { validateSemanticSimilarity, isSemanticValidationAvailable } from "../src/lib/semanticValidator";
import { validateRender } from "../src/lib/renderValidation";

const inputImage = process.argv[2] || "public/generated-thumbs/uploaded_idea_mk24sxii_kchwik_1767676257450.png";
const outputImage = process.argv[3] || "public/generated-thumbs/manual_BrickHero_V2.png";
const mpdFile = process.argv[4] || "data/ldraw/manual_BrickHero_V2.mpd";

async function main() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║         COMPREHENSIVE VALIDATION TEST                      ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nInput:  ${inputImage}`);
  console.log(`Output: ${outputImage}`);
  console.log(`MPD:    ${mpdFile}`);

  // 1. Image Similarity
  console.log("\n" + "=".repeat(60));
  console.log("1. IMAGE SIMILARITY (SSIM)");
  console.log("=".repeat(60));
  console.log("Tools:", JSON.stringify(checkImageComparisonTools(), null, 2));
  
  try {
    const sim = compareImages(outputImage, inputImage);
    console.log(`\n  Score: ${sim.overall}%`);
    console.log(`  SSIM: ${sim.metrics.ssim?.toFixed(4)}`);
    console.log(`  MSE: ${sim.metrics.mse?.toFixed(2)}`);
    console.log(`  Method: ${sim.details?.method}`);
    console.log(`  Verdict: ${sim.overall >= 60 ? "✅ PASS" : "❌ FAIL"} (threshold: 60%)`);
  } catch (e: any) {
    console.log("  Error:", e.message);
  }

  // 2. Connection Validation
  console.log("\n" + "=".repeat(60));
  console.log("2. CONNECTION VALIDATION (Stud/Grid Alignment)");
  console.log("=".repeat(60));
  console.log("Available:", isConnectionValidationAvailable());
  
  if (fs.existsSync(mpdFile)) {
    try {
      const conn = validateLegoConnections(mpdFile);
      console.log(`\n  Valid: ${conn.isValid ? "✅ YES" : "❌ NO"}`);
      console.log(`  Total parts: ${conn.stats.total_parts}`);
      console.log(`  Connections: ${conn.stats.connections}`);
      console.log(`  Errors: ${conn.stats.errors}`);
      console.log(`  Warnings: ${conn.stats.warnings}`);
      
      if (conn.issues.length > 0) {
        console.log("\n  Top issues:");
        const grouped = conn.issues.reduce((acc, i) => {
          const key = `${i.type}`;
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);
        Object.entries(grouped).sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([type, count]) => {
          console.log(`    ${type}: ${count} occurrences`);
        });
      }
    } catch (e: any) {
      console.log("  Error:", e.message);
    }
  } else {
    console.log("  MPD file not found");
  }

  // 3. Render Validation (Structure + Continuity)
  console.log("\n" + "=".repeat(60));
  console.log("3. RENDER VALIDATION (Structure + Continuity)");
  console.log("=".repeat(60));
  
  if (fs.existsSync(mpdFile)) {
    try {
      const mpd = fs.readFileSync(mpdFile, "utf-8");
      const render = validateRender({
        ldraw_mpd: mpd,
        mode: "full",
        reference_image_path: inputImage,
        min_similarity: 60
      });
      
      console.log(`\n  Valid: ${render.valid ? "✅ YES" : "❌ NO"}`);
      console.log(`  Structure: ${render.structure.valid ? "✅" : "❌"} (${render.structure.issues.length} issues)`);
      console.log(`  Continuity: ${render.continuity.valid ? "✅" : "❌"} (${render.continuity.issues.length} issues)`);
      
      if (render.structure.issues.length > 0) {
        console.log("\n  Structure issues:");
        render.structure.issues.slice(0, 3).forEach(i => console.log(`    [${i.severity}] ${i.message}`));
      }
      if (render.continuity.issues.length > 0) {
        console.log("\n  Continuity issues:");
        render.continuity.issues.slice(0, 5).forEach(i => console.log(`    [${i.severity}] ${i.message}`));
      }
    } catch (e: any) {
      console.log("  Error:", e.message);
    }
  } else {
    console.log("  MPD file not found");
  }

  // 4. Semantic Validation
  console.log("\n" + "=".repeat(60));
  console.log("4. SEMANTIC VALIDATION (AI Vision Comparison)");
  console.log("=".repeat(60));
  console.log("Available:", isSemanticValidationAvailable());
  
  try {
    const semantic = await validateSemanticSimilarity(inputImage, outputImage);
    console.log(`\n  Valid: ${semantic.isValid ? "✅ YES" : "❌ NO"}`);
    console.log(`  Similarity: ${semantic.similarityScore}%`);
    console.log(`  Overall Match: ${semantic.overallMatch}`);
    
    console.log("\n  Components:");
    console.log(`    Expected: ${semantic.components.expected.join(", ") || "(none)"}`);
    console.log(`    Found: ${semantic.components.found.join(", ") || "(none)"}`);
    console.log(`    Missing: ${semantic.components.missing.join(", ") || "(none)"}`);
    console.log(`    Misplaced: ${semantic.components.misplaced.join(", ") || "(none)"}`);
    
    if (semantic.proportions) {
      console.log(`\n  Proportions: ${semantic.proportions.correct ? "✅ OK" : "❌ Issues"}`);
      if (!semantic.proportions.correct && semantic.proportions.issues) {
        semantic.proportions.issues.forEach(i => console.log(`    - ${i}`));
      }
    }
    
    if (semantic.orientation) {
      console.log(`  Orientation: ${semantic.orientation.correct ? "✅ OK" : "❌ " + semantic.orientation.issue}`);
    }
    
    console.log("\n  Summary:");
    console.log(`    ${semantic.summary?.slice(0, 500) || "(none)"}`);
    
    if (semantic.issues.length > 0) {
      console.log("\n  Detailed Issues:");
      semantic.issues.slice(0, 5).forEach(i => {
        console.log(`    [${i.severity}] ${i.type}: ${i.component || ""}`);
        if (i.expected) console.log(`      Expected: ${i.expected}`);
        if (i.actual) console.log(`      Actual: ${i.actual}`);
      });
    }
  } catch (e: any) {
    console.log("  Error:", e.message);
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
}

main().catch(console.error);
