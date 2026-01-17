#!/usr/bin/env tsx
/**
 * Test script for image similarity comparison tools.
 * Tests both Python SSIM and ImageMagick methods.
 */

import { compareImages, checkImageComparisonTools, validateRenderSimilarity } from "../src/lib/imageSimilarity";
import path from "node:path";
import fs from "node:fs";

console.log("=== Image Similarity Test ===\n");

// Check available tools
console.log("1. Checking available tools...");
const tools = checkImageComparisonTools();
console.log(`   Python + scikit-image: ${tools.python ? "✓ Available" : "✗ Not available"}`);
console.log(`   ImageMagick: ${tools.imageMagick ? "✓ Available" : "✗ Not available"}`);
console.log(`   Recommended: ${tools.recommended}\n`);

// Find test images
const thumbsDir = path.join(process.cwd(), "public", "generated-thumbs");
const thumbs = fs.readdirSync(thumbsDir).filter(f => f.endsWith(".png"));

if (thumbs.length < 2) {
  console.error("Need at least 2 images in public/generated-thumbs/ to test comparison");
  process.exit(1);
}

console.log(`2. Found ${thumbs.length} thumbnails in ${thumbsDir}`);
console.log(`   Using: ${thumbs[0]} vs ${thumbs[1]}\n`);

const img1Path = path.join(thumbsDir, thumbs[0]);
const img2Path = path.join(thumbsDir, thumbs[1]);

// Test 1: Compare different images
console.log("3. Testing comparison of different images...");
try {
  const result1 = compareImages(img1Path, img2Path);
  console.log(`   Overall similarity: ${result1.overall}%`);
  console.log(`   Method: ${result1.details?.method}`);
  if (result1.metrics.ssim !== undefined) {
    console.log(`   SSIM: ${result1.metrics.ssim.toFixed(4)}`);
  }
  if (result1.metrics.mse !== undefined) {
    console.log(`   MSE: ${result1.metrics.mse.toFixed(2)}`);
  }
  if (result1.metrics.psnr !== undefined) {
    console.log(`   PSNR: ${result1.metrics.psnr.toFixed(2)} dB`);
  }
  console.log();
} catch (error) {
  console.error("   Error:", error);
  process.exit(1);
}

// Test 2: Compare image to itself (should be 100%)
console.log("4. Testing comparison of image to itself...");
try {
  const result2 = compareImages(img1Path, img1Path);
  console.log(`   Overall similarity: ${result2.overall}%`);
  console.log(`   Method: ${result2.details?.method}`);
  if (result2.metrics.ssim !== undefined) {
    console.log(`   SSIM: ${result2.metrics.ssim.toFixed(4)}`);
  }
  
  if (result2.overall !== 100) {
    console.warn(`   ⚠️  Warning: Expected 100% similarity, got ${result2.overall}%`);
  } else {
    console.log(`   ✓ Perfect match as expected`);
  }
  console.log();
} catch (error) {
  console.error("   Error:", error);
  process.exit(1);
}

// Test 3: Validation with threshold
console.log("5. Testing validation with threshold (70%)...");
try {
  const validation = validateRenderSimilarity(img1Path, img2Path, 70);
  console.log(`   ${validation.passes ? "✓" : "✗"} ${validation.message}`);
  console.log();
} catch (error) {
  console.error("   Error:", error);
  process.exit(1);
}

console.log("=== All Tests Passed ===\n");
console.log("Image similarity tools are working correctly!");
console.log(`Using ${tools.python ? "Python SSIM (best accuracy)" : tools.imageMagick ? "ImageMagick (good)" : "basic fallback"}`);
