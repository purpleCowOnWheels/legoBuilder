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

import { generateBlueprintMultiPhase, setRunLogDir } from "@/lib/openai";
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
  
  // Setup logging directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const logDir = path.join(process.cwd(), "data", "pipeline-output", `run_${timestamp}`);
  fs.mkdirSync(logDir, { recursive: true });
  
  // Direct all debug artifacts to this run's folder
  setRunLogDir(logDir);
  
  // Copy input image to log directory
  const inputImageDest = path.join(logDir, "00_input_image.png");
  fs.copyFileSync(args.imagePath, inputImageDest);
  
  // Load inventory
  const db = readDb();
  const inventory: InventoryItem[] = db.inventory || [];
  
  console.log("══════════════════════════════════════════════════");
  console.log("LEGO BUILD PIPELINE");
  console.log("══════════════════════════════════════════════════");
  console.log(`Mode: ${args.fullMode ? "Full" : "Debug (1 sub-assembly)"}`);
  console.log(`Inventory: ${inventory.length} part types`);
  console.log(`Output: ${logDir}`);
  
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
    
    // Save final summary to file
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
    
    if (!args.fullMode) {
      console.log("\nTo run full pipeline:");
      console.log(`  npx tsx scripts/run-multiphase-pipeline.ts --image ${args.imagePath} --full`);
    }
    
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
  } finally {
    // Reset log directory for future runs
    setRunLogDir(null);
  }
}

main().catch(console.error);
