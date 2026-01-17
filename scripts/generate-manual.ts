#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { generateInstructionsPdfFromMpd, generateThumbnailPngFromMpd, writeIdeaMpdToDisk } from "../src/lib/lpub3d";

const mpdPath = process.argv[2];
if (!mpdPath) {
  console.error("Usage: tsx scripts/generate-manual.ts <path-to-mpd-file>");
  process.exit(1);
}

if (!fs.existsSync(mpdPath)) {
  console.error(`Error: File not found: ${mpdPath}`);
  process.exit(1);
}

let ldrawMpd = fs.readFileSync(mpdPath, "utf-8");
const baseName = path.basename(mpdPath, path.extname(mpdPath));

console.log(`Processing: ${mpdPath}`);
console.log(`Base name: ${baseName}`);

// Fix MPD structure if needed: Ensure the first FILE is the main model
// Some MPDs have an empty wrapper file, then submodels, then the actual main model
const lines = ldrawMpd.split("\n");
const fileStartIndices: number[] = [];
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith("0 FILE ")) {
    fileStartIndices.push(i);
  }
}

if (fileStartIndices.length > 1) {
  // Check if the first file is mostly empty (just headers, no parts)
  const firstFileEnd = fileStartIndices[1];
  const firstFileContent = lines.slice(fileStartIndices[0], firstFileEnd);
  const hasActualParts = firstFileContent.some(line => {
    const trimmed = line.trim();
    return trimmed.startsWith("1 ") && !trimmed.includes("!LDRAW_ORG");
  });
  
  if (!hasActualParts) {
    console.log("\n⚠️  Detected wrapper MPD structure. Attempting to restructure for LPub3D...");
    // Find MODEL.ldr or the last FILE entry (usually the main model)
    let mainModelIndex = fileStartIndices.find((idx) => {
      const fileName = lines[idx].replace(/^0 FILE\s+/, "").trim();
      return fileName.toLowerCase().includes("model");
    });
    
    if (!mainModelIndex) {
      mainModelIndex = fileStartIndices[fileStartIndices.length - 1];
    }
    
    console.log(`   Found main model at line ${mainModelIndex + 1}`);
    
    // Restructure: move main model to the front, keep submodels after
    const mainModelStartIdx = mainModelIndex;
    const mainModelEndIdx = fileStartIndices[fileStartIndices.indexOf(mainModelStartIdx) + 1] || lines.length;
    const mainModelLines = lines.slice(mainModelStartIdx, mainModelEndIdx);
    
    // Collect all other files (submodels)
    const submodelLines: string[] = [];
    for (let i = 1; i < fileStartIndices.length; i++) {
      if (fileStartIndices[i] === mainModelStartIdx) continue; // Skip main model
      const start = fileStartIndices[i];
      const end = fileStartIndices[i + 1] || lines.length;
      submodelLines.push(...lines.slice(start, end));
    }
    
    // Rebuild MPD: main model first, then submodels
    ldrawMpd = [...mainModelLines, ...submodelLines].join("\n");
    console.log(`   ✓ Restructured MPD (main model moved to front)`);
  }
}

try {
  // Write MPD to our temp directory for LPub3D processing
  console.log("\n1. Writing MPD to temp directory...");
  const tempMpdPath = writeIdeaMpdToDisk({ baseName: `manual_${baseName}`, ldrawMpd });
  console.log(`   ✓ Written to: ${tempMpdPath}`);

  // Generate thumbnail
  console.log("\n2. Generating thumbnail...");
  const thumb = generateThumbnailPngFromMpd({ mpdPath: tempMpdPath, baseName: `manual_${baseName}`, size: 1024 });
  console.log(`   ✓ Thumbnail: ${thumb.url}`);
  console.log(`   ✓ Path: ${thumb.outPath}`);

  // Generate PDF instructions
  console.log("\n3. Generating PDF instructions (this may take a minute)...");
  console.log("   Note: If this hangs, it may be due to LPub3D GUI issues. Try pressing Ctrl+C and checking the thumbnail.");
  const pdf = generateInstructionsPdfFromMpd({ mpdPath: tempMpdPath, baseName: `manual_${baseName}`, timeoutMs: 60000 });
  console.log(`   ✓ PDF: ${pdf.url}`);
  console.log(`   ✓ Path: ${pdf.outPath}`);

  console.log("\n✅ Done! Files generated:");
  console.log(`   - Thumbnail: http://localhost:3000${thumb.url}`);
  console.log(`   - PDF: http://localhost:3000${pdf.url}`);
  console.log(`\nLocal paths:`);
  console.log(`   - ${thumb.outPath}`);
  console.log(`   - ${pdf.outPath}`);
} catch (error) {
  console.error("\n❌ Error:", error instanceof Error ? error.message : error);
  process.exit(1);
}

