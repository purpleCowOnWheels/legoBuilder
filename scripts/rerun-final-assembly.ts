#!/usr/bin/env npx tsx
/**
 * Re-run just the final assembly step from an existing pipeline run.
 * Usage: npx tsx scripts/rerun-final-assembly.ts <run-directory>
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import fs from "fs";
import path from "path";
import { assembleFinalProduct, setRunLogDir } from "../src/lib/openai";
import { InventoryItem } from "../src/lib/inventory";

const runDir = process.argv[2];
if (!runDir) {
  console.error("Usage: npx tsx scripts/rerun-final-assembly.ts <run-directory>");
  console.error("Example: npx tsx scripts/rerun-final-assembly.ts data/pipeline-output/run_2026-01-18T03-22-29");
  process.exit(1);
}

const absRunDir = path.resolve(runDir);
if (!fs.existsSync(absRunDir)) {
  console.error(`Run directory not found: ${absRunDir}`);
  process.exit(1);
}

async function main() {
  console.log(`\nRe-running final assembly from: ${absRunDir}\n`);

  // Load structure plan
  const structurePlanPath = path.join(absRunDir, "01_structure_plan/output.json");
  if (!fs.existsSync(structurePlanPath)) {
    throw new Error(`Structure plan not found: ${structurePlanPath}`);
  }
  const structurePlan = JSON.parse(fs.readFileSync(structurePlanPath, "utf8"));
  console.log(`Loaded structure plan: ${structurePlan.subassemblies.length} subassemblies`);

  // Load reference image
  const referenceImagePath = path.join(absRunDir, "00_input_image.png");
  if (!fs.existsSync(referenceImagePath)) {
    throw new Error(`Reference image not found: ${referenceImagePath}`);
  }
  console.log(`Reference image: ${referenceImagePath}`);

  // Load inventory (use sample if not in run dir)
  let inventory: InventoryItem[];
  const inventoryPath = path.join(absRunDir, "inventory.json");
  if (fs.existsSync(inventoryPath)) {
    const invData = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
    inventory = Array.isArray(invData) ? invData : invData.inventory;
  } else {
    // Fall back to sample inventory
    const sampleInventoryPath = path.join(process.cwd(), "scripts/sample-inventory.json");
    if (!fs.existsSync(sampleInventoryPath)) {
      throw new Error("No inventory found");
    }
    const invData = JSON.parse(fs.readFileSync(sampleInventoryPath, "utf8"));
    inventory = Array.isArray(invData) ? invData : invData.inventory;
  }
  console.log(`Loaded inventory: ${inventory.length} items`);

  // Load subassembly results
  const subassembliesDir = path.join(absRunDir, "subassemblies");
  if (!fs.existsSync(subassembliesDir)) {
    throw new Error(`Subassemblies directory not found: ${subassembliesDir}`);
  }

  const subassemblyFolders = fs.readdirSync(subassembliesDir)
    .filter(f => !f.startsWith(".") && fs.statSync(path.join(subassembliesDir, f)).isDirectory());

  const subassemblyResults = subassemblyFolders.map(folder => {
    const folderPath = path.join(subassembliesDir, folder);
    const ldrawPath = path.join(folderPath, "ldraw.mpd");
    
    if (!fs.existsSync(ldrawPath)) {
      throw new Error(`LDraw MPD not found for subassembly ${folder}: ${ldrawPath}`);
    }
    
    const ldrawMpd = fs.readFileSync(ldrawPath, "utf8");
    const pieceCount = ldrawMpd.split('\n').filter(l => l.trim().startsWith('1 ')).length;
    
    // Convert folder name to display name
    const displayName = folder.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    
    return {
      subassembly_name: displayName,
      ldraw_mpd: ldrawMpd,
      actual_pieces: pieceCount,
      validation_rounds: 1
    };
  });

  console.log(`\nLoaded ${subassemblyResults.length} subassemblies:`);
  for (const sa of subassemblyResults) {
    console.log(`  - ${sa.subassembly_name} (${sa.actual_pieces} pieces)`);
  }

  const totalPieces = subassemblyResults.reduce((sum, sa) => sum + sa.actual_pieces, 0);
  console.log(`\nTotal pieces: ${totalPieces}`);

  // Run final assembly
  console.log("\n========================================");
  console.log("  Running Final Assembly");
  console.log("========================================\n");

  // Set log directory so all renders go to the job folder
  setRunLogDir(absRunDir);

  const result = await assembleFinalProduct({
    structurePlan,
    subassemblyResults,
    referenceImagePath,
    inventory,
    logDir: absRunDir
  });

  console.log("\n========================================");
  console.log("  Final Assembly Complete");
  console.log("========================================");
  console.log(`Validation rounds: ${result.validationRounds}`);
  if (result.finalSimilarity !== undefined) {
    console.log(`Final similarity: ${(result.finalSimilarity * 100).toFixed(0)}%`);
  }

  // Save final MPD
  const finalMpdPath = path.join(absRunDir, "final.mpd");
  fs.writeFileSync(finalMpdPath, result.finalMpd, "utf8");
  console.log(`\nFinal MPD saved to: ${finalMpdPath}`);
}

main().catch(err => {
  console.error("\nFinal assembly failed:", err.message);
  process.exit(1);
});
