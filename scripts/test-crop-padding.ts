#!/usr/bin/env tsx

/**
 * Test different crop padding values to find optimal setting
 */

import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const SOURCE_IMAGE = "/Users/dan.costanza/repos/legoBuilder/data/grid-pipeline-output/tools_2026-01-18T17-44-58/00_reference.png";
const OUTPUT_DIR = "/Users/dan.costanza/repos/legoBuilder/data/crop-test";

// Sample bounding box (legs area - typical tight crop)
const SAMPLE_BOX = { x: 0.35, y: 0.65, width: 0.3, height: 0.35 };

const PADDING_VALUES = [0, 0.05, 0.10, 0.15, 0.20, 0.25];

async function cropWithPadding(
  sourcePath: string,
  boundingBox: { x: number; y: number; width: number; height: number },
  outputPath: string,
  padding: number
): Promise<void> {
  const image = sharp(sourcePath);
  const metadata = await image.metadata();
  
  if (!metadata.width || !metadata.height) {
    throw new Error("Could not get image dimensions");
  }
  
  // Calculate padded bounding box
  const padX = boundingBox.width * padding;
  const padY = boundingBox.height * padding;
  
  const x = Math.max(0, boundingBox.x - padX);
  const y = Math.max(0, boundingBox.y - padY);
  const right = Math.min(1, boundingBox.x + boundingBox.width + padX);
  const bottom = Math.min(1, boundingBox.y + boundingBox.height + padY);
  
  const left = Math.round(x * metadata.width);
  const top = Math.round(y * metadata.height);
  const width = Math.round((right - x) * metadata.width);
  const height = Math.round((bottom - y) * metadata.height);
  
  console.log(`Padding ${(padding * 100).toFixed(0)}%: crop ${width}x${height} at (${left}, ${top})`);
  
  await image
    .extract({ left, top, width, height })
    .toFile(outputPath);
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  
  console.log("Testing crop padding values...\n");
  console.log(`Source: ${SOURCE_IMAGE}`);
  console.log(`Bounding box: x=${SAMPLE_BOX.x}, y=${SAMPLE_BOX.y}, w=${SAMPLE_BOX.width}, h=${SAMPLE_BOX.height}\n`);
  
  for (const padding of PADDING_VALUES) {
    const filename = `crop_padding_${(padding * 100).toFixed(0)}pct.png`;
    const outputPath = path.join(OUTPUT_DIR, filename);
    await cropWithPadding(SOURCE_IMAGE, SAMPLE_BOX, outputPath, padding);
  }
  
  console.log(`\nOutputs saved to: ${OUTPUT_DIR}`);
  console.log("Compare the images to find optimal padding.");
}

main().catch(console.error);
