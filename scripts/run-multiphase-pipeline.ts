#!/usr/bin/env tsx

/**
 * Multi-phase build pipeline with parallel subassembly generation
 * 
 * Usage:
 *   npx tsx scripts/run-multiphase-pipeline.ts --image path/to/image.png [--full]
 * 
 * Flags:
 *   --full    Run all subassemblies + final assembly (more expensive)
 *             Default: debug mode (first subassembly only)
 * 
 * Phases:
 *   1. Generate structure plan (subassemblies only)
 *   2a. Generate detailed step plans for each subassembly (parallel, or first only in debug)
 *   2b. Build and validate each subassembly (parallel, or first only in debug)
 *   3. Assemble final product and validate (skipped in debug mode)
 */

import { generateBlueprintMultiPhase } from "@/lib/openai";
import { readDb } from "@/lib/storage";
import type { InventoryItem } from "@/lib/models";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

// Load environment variables
dotenv.config({ path: path.join(process.cwd(), ".env.local") });

interface Args {
  imagePath: string;
  fullMode: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const imageIndex = args.indexOf("--image");
  
  if (imageIndex === -1 || !args[imageIndex + 1]) {
    console.error("Usage: npx tsx scripts/run-multiphase-pipeline.ts --image <path> [--full]");
    console.error("");
    console.error("Flags:");
    console.error("  --full    Run all subassemblies + final assembly (more expensive)");
    console.error("            Default: debug mode (first subassembly only)");
    process.exit(1);
  }

  const imagePath = args[imageIndex + 1];
  if (!fs.existsSync(imagePath)) {
    console.error(`Error: Image not found: ${imagePath}`);
    process.exit(1);
  }

  const fullMode = args.includes("--full");

  return { imagePath, fullMode };
}

async function main() {
  const args = parseArgs();
  
  console.log("========================================");
  console.log("MULTI-PHASE LEGO BUILD PIPELINE");
  console.log("========================================");
  console.log(`Mode: ${args.fullMode ? "FULL (all subassemblies + final assembly)" : "DEBUG (first subassembly only)"}`);
  console.log("");
  
  // Setup logging directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const logDir = path.join(process.cwd(), "data", "pipeline-output", `run_${timestamp}`);
  fs.mkdirSync(logDir, { recursive: true });
  
  console.log(`Log directory: ${logDir}\n`);
  
  // Copy input image to log directory
  const inputImageDest = path.join(logDir, "00_input_image.png");
  fs.copyFileSync(args.imagePath, inputImageDest);
  console.log(`Input image copied to: ${inputImageDest}\n`);
  
  // Load inventory
  console.log("Loading inventory...");
  const db = readDb();
  const inventory: InventoryItem[] = db.inventory || [];
  console.log(`  → ${inventory.length} unique part types loaded\n`);
  
  if (inventory.length === 0) {
    console.error("Error: Inventory is empty!");
    process.exit(1);
  }
  
  // Run the multi-phase pipeline
  try {
    const result = await generateBlueprintMultiPhase({
      referenceImagePath: args.imagePath,
      inventory,
      constraintsText: "Build something interesting with the available parts.",
      logDir,
      debugMode: !args.fullMode
    });
    
    // Save final summary
    const summary = {
      timestamp,
      inputImage: args.imagePath,
      structurePlan: result.structurePlan,
      subassemblies: result.subassemblyResults.map(sa => ({
        name: sa.subassembly_name,
        pieces: sa.actual_pieces,
        validation_rounds: sa.validation_rounds,
        final_similarity: sa.final_similarity_score
      })),
      totalPieces: result.subassemblyResults.reduce((sum, sa) => sum + sa.actual_pieces, 0),
      totalValidationRounds: result.subassemblyResults.reduce((sum, sa) => sum + sa.validation_rounds, 0)
    };
    
    const summaryPath = path.join(logDir, "99_summary.json");
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
    
    console.log("\n========================================");
    console.log("SUMMARY");
    console.log("========================================");
    console.log(`Structure plan: ${logDir}/01_structure_plan_output.json`);
    console.log(`\nSubassembly plans (Phase 2a):`);
    result.structurePlan.subassemblies.forEach((sa, i) => {
      const safeName = sa.name.replace(/[^a-z0-9]/gi, '_');
      console.log(`  ${i + 1}. ${sa.name}`);
      console.log(`     Plan: ${logDir}/02a_subassembly_plan_${safeName}_output.json`);
    });
    
    console.log(`\nSubassembly builds (Phase 2b):`);
    result.subassemblyResults.forEach((sa, i) => {
      const safeName = sa.subassembly_name.replace(/[^a-z0-9]/gi, '_');
      console.log(`  ${i + 1}. ${sa.subassembly_name}`);
      console.log(`     LDraw: ${logDir}/02b_subassembly_build_${safeName}_ldraw.mpd`);
      console.log(`     Validation: ${logDir}/02b_subassembly_build_${safeName}_validation.json`);
    });
    
    if (result.finalMpd) {
      console.log(`\nFinal assembly (Phase 3):`);
      console.log(`  Input: ${logDir}/03_final_assembly_input_combined.mpd`);
      console.log(`  Output: ${logDir}/03_final_assembly_output.mpd`);
      console.log(`  Validation: ${logDir}/03_final_assembly_validation.json`);
    } else {
      console.log(`\nFinal assembly: skipped (debug mode)`);
    }
    
    console.log(`\nSummary: ${summaryPath}`);
    
    if (!args.fullMode) {
      console.log("\n💡 To run full pipeline with all subassemblies + final assembly:");
      console.log(`   npx tsx scripts/run-multiphase-pipeline.ts --image ${args.imagePath} --full`);
    }
    
    console.log("\n✓ Pipeline complete!");
    
  } catch (error) {
    console.error("\n✗ Pipeline failed:");
    console.error(error);
    
    // Save error log
    const errorPath = path.join(logDir, "ERROR.txt");
    fs.writeFileSync(
      errorPath,
      `Pipeline failed at ${new Date().toISOString()}\n\n${error instanceof Error ? error.stack : String(error)}`,
      "utf8"
    );
    console.error(`\nError log saved to: ${errorPath}`);
    
    process.exit(1);
  }
}

main().catch(console.error);
