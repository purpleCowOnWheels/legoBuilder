import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * Image similarity comparison utilities for validating generated LEGO renders
 * against input/reference images.
 */

export interface SimilarityScore {
  /** Overall similarity score (0-100, where 100 is identical) */
  overall: number;
  
  /** Individual metric scores */
  metrics: {
    /** Structural Similarity Index (SSIM) - best for structural comparison */
    ssim?: number;
    
    /** Mean Squared Error (MSE) - pixel-level difference */
    mse?: number;
    
    /** Peak Signal-to-Noise Ratio (PSNR) */
    psnr?: number;
    
    /** Perceptual hash similarity (0-1) */
    perceptualHash?: number;
  };
  
  /** Detailed comparison info */
  details?: {
    dimensions: { width: number; height: number };
    sizeMatch: boolean;
    method: "python" | "imageMagick" | "basic";
  };
}

/**
 * Compare two images and return a similarity score.
 * 
 * This function will try multiple methods in order of preference:
 * 1. Python with scikit-image (most accurate)
 * 2. ImageMagick compare (widely available)
 * 3. Basic perceptual hash comparison (fallback)
 * 
 * @param image1Path - Path to first image (e.g., generated render)
 * @param image2Path - Path to second image (e.g., input/reference)
 * @returns Similarity score and metrics
 */
export function compareImages(image1Path: string, image2Path: string): SimilarityScore {
  if (!fs.existsSync(image1Path)) {
    throw new Error(`Image not found: ${image1Path}`);
  }
  if (!fs.existsSync(image2Path)) {
    throw new Error(`Image not found: ${image2Path}`);
  }

  // Try Python SSIM first (most accurate)
  const pythonResult = tryPythonSSIM(image1Path, image2Path);
  if (pythonResult) {
    return pythonResult;
  }

  // Try ImageMagick next
  const imageMagickResult = tryImageMagick(image1Path, image2Path);
  if (imageMagickResult) {
    return imageMagickResult;
  }

  // Fallback to basic comparison
  console.warn("Advanced image comparison not available. Using basic perceptual hash.");
  return basicPerceptualHashComparison(image1Path, image2Path);
}

/**
 * Try using Python with scikit-image for SSIM calculation
 */
function tryPythonSSIM(image1Path: string, image2Path: string): SimilarityScore | null {
  try {
    // Create a temporary Python script
    const scriptPath = path.join(process.cwd(), ".tmp-similarity.py");
    const pythonScript = `
import sys
import json
from skimage import io, metrics
import numpy as np

def calculate_similarity(img1_path, img2_path):
    img1 = io.imread(img1_path)
    img2 = io.imread(img2_path)
    
    # Resize if dimensions don't match
    if img1.shape != img2.shape:
        from skimage.transform import resize
        img2 = resize(img2, img1.shape, anti_aliasing=True)
        img2 = (img2 * 255).astype(np.uint8)
    
    # Calculate SSIM
    if len(img1.shape) == 3:  # Color image
        ssim = metrics.structural_similarity(img1, img2, channel_axis=2)
    else:  # Grayscale
        ssim = metrics.structural_similarity(img1, img2)
    
    # Calculate MSE and PSNR
    mse = metrics.mean_squared_error(img1, img2)
    psnr = metrics.peak_signal_noise_ratio(img1, img2)
    
    # Handle infinity (perfect match)
    if np.isinf(psnr):
        psnr = 100.0
    
    return {
        "ssim": float(ssim),
        "mse": float(mse),
        "psnr": float(psnr),
        "dimensions": {"width": img1.shape[1], "height": img1.shape[0]},
        "size_match": img1.shape == img2.shape
    }

if __name__ == "__main__":
    result = calculate_similarity(sys.argv[1], sys.argv[2])
    print(json.dumps(result))
`;

    fs.writeFileSync(scriptPath, pythonScript, "utf8");

    const result = spawnSync("python3", [scriptPath, image1Path, image2Path], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024
    });

    // Clean up temp script
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // Ignore cleanup errors
    }

    if (result.status === 0 && result.stdout) {
      const data = JSON.parse(result.stdout.trim());
      
      // Convert SSIM (0-1) to 0-100 scale
      const overall = Math.round(data.ssim * 100);
      
      return {
        overall,
        metrics: {
          ssim: data.ssim,
          mse: data.mse,
          psnr: data.psnr
        },
        details: {
          dimensions: data.dimensions,
          sizeMatch: data.size_match,
          method: "python"
        }
      };
    }
  } catch (error) {
    console.debug("Python SSIM not available:", error instanceof Error ? error.message : String(error));
  }

  return null;
}

/**
 * Try using ImageMagick's compare command
 */
function tryImageMagick(image1Path: string, image2Path: string): SimilarityScore | null {
  try {
    // Try using ImageMagick's compare with SSIM metric
    const result = spawnSync("compare", [
      "-metric", "SSIM",
      image1Path,
      image2Path,
      "null:"
    ], {
      encoding: "utf8",
      timeout: 30000
    });

    // ImageMagick outputs the metric to stderr
    const output = result.stderr?.trim() || result.stdout?.trim();
    
    if (output) {
      const ssim = parseFloat(output);
      if (!isNaN(ssim) && ssim >= 0 && ssim <= 1) {
        const overall = Math.round(ssim * 100);
        
        return {
          overall,
          metrics: {
            ssim
          },
          details: {
            dimensions: { width: 0, height: 0 }, // ImageMagick doesn't provide this easily
            sizeMatch: true,
            method: "imageMagick"
          }
        };
      }
    }
  } catch (error) {
    console.debug("ImageMagick not available:", error instanceof Error ? error.message : String(error));
  }

  return null;
}

/**
 * Basic perceptual hash comparison (fallback when better tools aren't available)
 */
function basicPerceptualHashComparison(image1Path: string, image2Path: string): SimilarityScore {
  // This is a very basic fallback - just compute file hashes
  const hash1 = computeFileHash(image1Path);
  const hash2 = computeFileHash(image2Path);
  
  const exact = hash1 === hash2;
  const overall = exact ? 100 : 0;
  
  return {
    overall,
    metrics: {
      perceptualHash: exact ? 1 : 0
    },
    details: {
      dimensions: { width: 0, height: 0 },
      sizeMatch: false,
      method: "basic"
    }
  };
}

function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Check if required tools are available for image comparison
 */
export function checkImageComparisonTools(): {
  python: boolean;
  imageMagick: boolean;
  recommended: string;
} {
  let python = false;
  let imageMagick = false;

  // Check Python + scikit-image
  try {
    const result = spawnSync("python3", ["-c", "import skimage; print('ok')"], {
      encoding: "utf8",
      timeout: 5000
    });
    python = result.status === 0 && result.stdout?.includes("ok");
  } catch {
    // Not available
  }

  // Check ImageMagick
  try {
    const result = spawnSync("compare", ["-version"], {
      encoding: "utf8",
      timeout: 5000
    });
    imageMagick = result.status === 0;
  } catch {
    // Not available
  }

  let recommended = "None available. ";
  if (python) {
    recommended = "Python with scikit-image (installed) - BEST option";
  } else if (imageMagick) {
    recommended = "ImageMagick (installed) - Good option";
  } else {
    recommended += "Install Python scikit-image: pip install scikit-image";
  }

  return { python, imageMagick, recommended };
}

/**
 * Validate that a render matches the input image within acceptable threshold
 */
export function validateRenderSimilarity(
  renderPath: string,
  referencePath: string,
  minSimilarity: number = 70
): {
  passes: boolean;
  score: SimilarityScore;
  message: string;
} {
  const score = compareImages(renderPath, referencePath);
  const passes = score.overall >= minSimilarity;
  
  let message = `Similarity score: ${score.overall}% `;
  if (passes) {
    message += `(passes threshold of ${minSimilarity}%)`;
  } else {
    message += `(fails threshold of ${minSimilarity}%)`;
  }
  
  if (score.metrics.ssim !== undefined) {
    message += ` [SSIM: ${score.metrics.ssim.toFixed(3)}]`;
  }
  
  return { passes, score, message };
}
