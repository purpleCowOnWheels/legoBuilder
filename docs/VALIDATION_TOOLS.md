# Validation Tools Setup

This document describes the validation tools available for detecting errors in generated LDraw models and comparing rendered images.

## 🎯 Overview

Three validation capabilities are available:

1. **LDraw Structure Validation** (Built-in) - Syntax and basic structure checks
2. **Image Similarity** (Installed ✓) - Compare renders to input images
3. **Collision Detection** (Optional) - Detect overlapping parts with LDInspector

---

## ✅ Installed Tools

### 1. ImageMagick (Installed ✓)

**Purpose**: Image comparison using SSIM (Structural Similarity Index)

**Installed at**: `/opt/homebrew/bin/compare`

**Version**: ImageMagick 7.1.2-12

**Test**:
```bash
compare -version
```

### 2. Python scikit-image (Installed ✓)

**Purpose**: Advanced image similarity metrics (SSIM, MSE, PSNR)

**Installed**: Python 3.12.7 with scikit-image 0.26.0

**Test**:
```bash
python3 -c "import skimage; print(skimage.__version__)"
```

**Provides**:
- SSIM (Structural Similarity Index) - Best for perceptual comparison
- MSE (Mean Squared Error) - Pixel-level difference
- PSNR (Peak Signal-to-Noise Ratio) - Signal quality metric

---

## 🔧 Built-in Validation

### LDraw Structure Validation

**Location**: `src/lib/ldrawValidate.ts`

**Checks**:
- File structure (0 FILE, 0 NOFILE directives)
- Part placement lines (type 1 lines)
- Invalid coordinates (NaN values)
- Code fence contamination
- Chunk validation for MPD generation

**Usage**:
```typescript
import { validateLDrawMpdOrThrow, validateLDrawStructure } from "@/lib/ldrawValidate";

// Throws on error
validateLDrawMpdOrThrow(mpdContent);

// Returns detailed results
const result = validateLDrawStructure(mpdContent);
console.log(result.isValid, result.issues);
```

### Image Similarity

**Location**: `src/lib/imageSimilarity.ts`

**Usage**:
```typescript
import { compareImages, validateRenderSimilarity } from "@/lib/imageSimilarity";

// Compare two images
const score = compareImages(renderPath, referencePath);
console.log(`Similarity: ${score.overall}%`);

// Validate with threshold
const validation = validateRenderSimilarity(renderPath, referencePath, 70);
console.log(validation.passes, validation.message);
```

---

## 📦 Optional: LDInspector

### What it does

- **Collision Detection**: Detects overlapping/intersecting parts
- **Illegal Connections**: Validates snap points and connection rules
- **T-Junctions**: Finds mesh discontinuities

### Installation

1. **Download** from: https://fam-frenz.de/stefan/ldi.html

2. **Install** to:
   - macOS: `/Applications/LDInspector.app/`
   - Or custom location (set `LDINSPECTOR_BIN` in `.env.local`)

3. **Configure** in `.env.local`:
   ```bash
   LDINSPECTOR_BIN=/Applications/LDInspector.app/Contents/MacOS/LDInspector
   ```

### Status

⚠️ **Not currently installed**

The validation pipeline will work without it (using built-in structure checks), but collision detection won't be available.

### Usage (when installed)

```typescript
import { runLDInspector } from "@/lib/ldrawValidate";

const result = runLDInspector(mpdPath, {
  checkCollisions: true,
  checkConnections: false,
  timeout: 30000
});

console.log(result.isValid, result.issues);
```

---

## 🧪 Test Scripts

### Test Image Similarity

```bash
npx tsx scripts/test-image-similarity.ts
```

**What it tests**:
- Available tools (Python SSIM, ImageMagick)
- Comparison of different images
- Self-comparison (should be 100%)
- Validation with threshold

**Requirements**: At least 2 PNG files in `public/generated-thumbs/`

### Test LDraw Validation

```bash
npx tsx scripts/test-ldraw-validation.ts
```

**What it tests**:
- Basic syntax validation
- Structural validation
- LDInspector integration (if available)
- Batch validation of all manual MPD files

**Requirements**: At least 1 MPD file in `data/ldraw/` (starting with `manual_`)

---

## 🔍 Validation Methods Comparison

| Feature | Structure Check | Image Similarity | LDInspector |
|---------|----------------|------------------|-------------|
| **Syntax errors** | ✅ Yes | ❌ No | ❌ No |
| **Missing parts** | ✅ Yes | ❌ No | ❌ No |
| **Invalid coords** | ✅ Yes | ❌ No | ❌ No |
| **Collisions** | ❌ No | ❌ No | ✅ Yes |
| **Visual accuracy** | ❌ No | ✅ Yes | ❌ No |
| **Illegal connections** | ❌ No | ❌ No | ✅ Yes |
| **Speed** | Fast | Fast | Slow |
| **Installation** | Built-in | Installed ✓ | Manual |

---

## 🚀 Recommended Validation Pipeline

For best results, use the unified validation module:

```typescript
import { validateRender, validateRenderForToolLoop } from "@/lib/renderValidation";

// Full validation with all checks
const result = validateRender({
  ldraw_mpd: mpdContent,
  mode: "partial", // or "full" or "chunk"
  reference_image_path: "/path/to/preview.png",
  min_similarity: 70
});

console.log(result.valid);           // Overall pass/fail
console.log(result.similarity?.score); // 0-100
console.log(result.structure.issues);  // Syntax errors
console.log(result.continuity.issues); // Alignment/isolation issues

// For OpenAI tool loop (simpler response)
const toolResult = validateRenderForToolLoop({
  ldraw_mpd: mpdContent,
  mode: "partial",
  reference_image_path: "/path/to/preview.png",
  min_similarity: 70
});
// Returns: { ok: boolean, error?: string, similarity_score?: number, issues?: [...] }
```

### Validation Checks Included

1. **Structure Validation** (always runs)
   - Syntax (FILE/NOFILE directives)
   - Part placement lines (type 1)
   - Invalid coordinates (NaN)

2. **Continuity Checks** (always runs)
   - Y-coordinate alignment (plate/brick heights)
   - X/Z stud grid alignment
   - Isolated parts (no neighbors)
   - Extreme coordinate values

3. **Render Comparison** (when reference image provided)
   - Renders MPD via LPub3D or LDView
   - Compares to reference using SSIM
   - Fails if similarity < threshold

4. **Collision Detection** (when LDInspector available)
   - Part intersections
   - Illegal connections

---

## 📊 Environment Variables

Add to `.env.local`:

```bash
# Optional: LDInspector path
LDINSPECTOR_BIN=/Applications/LDInspector.app/Contents/MacOS/LDInspector

# Optional: Minimum similarity threshold (0-100)
MIN_SIMILARITY_SCORE=70
```

---

## 🔄 Next Steps

To integrate into the generation pipeline:

1. Add validation calls to `src/lib/ldrawQueue.ts`
2. Report validation results in job status
3. Fail jobs that don't meet similarity threshold
4. Log all validation issues to `data/openai-debug/`

---

---

## 🔌 MCP Integration (Future)

The unified validation module (`src/lib/renderValidation.ts`) is designed to be wrapped as an MCP tool:

```typescript
import { MCP_TOOL_DEFINITION, validateRender } from "@/lib/renderValidation";

// MCP_TOOL_DEFINITION contains the JSON schema for the tool
// validateRender() returns JSON-serializable results

// Example MCP server handler:
async function handleValidateLDrawRender(params: RenderValidationInput) {
  const result = validateRender(params);
  return {
    // Include rendered image as base64 for vision models
    rendered_image_base64: result.rendered_image_base64,
    valid: result.valid,
    similarity_score: result.similarity?.score,
    issues: [
      ...result.structure.issues,
      ...result.continuity.issues
    ]
  };
}
```

This allows OpenAI to:
1. Generate LDraw MPD
2. Call the MCP tool to render and validate
3. See the rendered image and similarity score
4. Self-correct if validation fails

---

## 📚 References

- **LDInspector**: https://fam-frenz.de/stefan/ldi.html
- **SSIM**: https://en.wikipedia.org/wiki/Structural_similarity_index_measure
- **ImageMagick**: https://imagemagick.org/
- **scikit-image**: https://scikit-image.org/
