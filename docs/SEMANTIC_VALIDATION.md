# Semantic Similarity Validation

## What It Does

**Validates that the LEGO model conceptually matches the input image** - not just pixel-by-pixel, but understanding the actual content and structure.

### Key Differences from SSIM (Pixel Similarity)

| Aspect | SSIM (Pixel Similarity) | Semantic Validation |
|--------|------------------------|---------------------|
| **What it checks** | Pixel-level visual match | Conceptual/structural match |
| **Understands content** | No | Yes (knows what a "head" or "arm" is) |
| **Robustness** | Sensitive to minor changes | Robust to color/angle changes |
| **Checks structure** | No | Yes (components in right places) |
| **Speed** | Fast (~200ms) | Slower (~10-30s) |
| **Cost** | Free | OpenAI API call |

---

## What It Validates

### 1. **Component Presence** ✓
Checks if all major parts are present:
- Head, body, limbs, base, accessories
- Custom components based on input

### 2. **Spatial Layout** ✓
Verifies correct relative positions:
- Head on top of body
- Arms at sides
- Legs below torso
- Base at bottom

### 3. **Proportions** ✓
Validates size relationships:
- Head not too big/small
- Limbs appropriate length
- Overall balance

### 4. **Orientation** ✓
Checks facing direction:
- Front/back/side match
- Rotation correct

### 5. **Key Features** ✓
Identifies distinctive elements:
- Weapons, tools, accessories
- Unique shapes or patterns
- Characteristic details

---

## Usage

### TypeScript/Node.js

```typescript
import { validateSemanticSimilarity } from "@/lib/semanticValidator";

const result = await validateSemanticSimilarity(
  "path/to/input-image.png",
  "path/to/render.png"
);

console.log(`Match: ${result.overallMatch}`); // "excellent", "good", "fair", "poor"
console.log(`Score: ${result.similarityScore}%`); // 0-100

if (!result.isValid) {
  console.log("Missing components:", result.components.missing);
  console.log("Issues:", result.issues);
}
```

### Python (Direct)

```bash
python3 scripts/semantic_validator.py input.png render.png
```

### Test Script

```bash
npx tsx scripts/test-semantic-validation.ts
```

---

## Example Output

```json
{
  "is_valid": true,
  "similarity_score": 85,
  "components": {
    "expected": ["head", "body", "arms", "legs", "base"],
    "found": ["head", "body", "arms", "legs", "base"],
    "missing": [],
    "misplaced": []
  },
  "proportions": {
    "correct": true,
    "issues": []
  },
  "orientation": {
    "correct": true
  },
  "overall_match": "good",
  "issues": [
    {
      "type": "minor_proportion_issue",
      "component": "head",
      "severity": "warning"
    }
  ],
  "summary": "The LEGO model accurately captures the structure of the input image. All major components are present and correctly positioned. Minor proportion differences are acceptable for LEGO constraints."
}
```

---

## When to Use

### ✅ Use Semantic Validation When:
- You want to ensure conceptual accuracy
- Input and render may have different angles/lighting
- You need to verify structure, not just appearance
- Component placement is critical
- Building from sketches or concept art

### ✅ Use SSIM When:
- You want exact visual match
- Images should look nearly identical
- Speed is critical
- No API costs desired
- Simple comparison needed

### ✅ Use Both When:
- Maximum confidence required
- Production builds
- Critical validation pipeline

---

## Integration into Pipeline

### Option 1: Replace SSIM

```typescript
// In ldrawQueue.ts after rendering
const semanticResult = await validateSemanticSimilarity(
  inputImagePath,
  renderPath
);

if (semanticResult.similarityScore < 70) {
  throw new Error(`Model doesn't match input: ${semanticResult.summary}`);
}
```

### Option 2: Complement SSIM

```typescript
// Use both for comprehensive validation
const pixelSimilarity = compareImages(renderPath, inputPath);  // SSIM
const semanticResult = await validateSemanticSimilarity(inputPath, renderPath);

const isValid = 
  pixelSimilarity.overall >= 60 &&  // Reasonable visual match
  semanticResult.similarityScore >= 75;  // Good conceptual match
```

### Option 3: Two-Stage Validation

```typescript
// Fast check first (SSIM), deep check if uncertain
const ssim = compareImages(renderPath, inputPath);

if (ssim.overall < 50) {
  // Clearly wrong, fail fast
  throw new Error("Visual mismatch");
} else if (ssim.overall < 80) {
  // Uncertain, do semantic check
  const semantic = await validateSemanticSimilarity(inputPath, renderPath);
  if (!semantic.isValid) {
    throw new Error(`Structural mismatch: ${semantic.summary}`);
  }
}
// ssim >= 80, looks good, skip expensive semantic check
```

---

## Performance

- **Speed**: 10-30 seconds per validation
- **Cost**: ~$0.01-0.02 per validation (OpenAI Vision API)
- **Accuracy**: Very high for structural/conceptual matches

### Optimization Tips

1. **Cache results** - Don't re-validate unchanged models
2. **Batch validations** - Validate multiple at once
3. **Use for final validation only** - Not every iteration
4. **Fast model for quick checks** - Use `gpt-4o-mini` for component presence

---

## Requirements

- Python 3.x
- `requests` library (`pip install requests`)
- OpenAI API key with Vision access
- Input and render images (PNG/JPEG)

---

## Limitations

- Requires OpenAI API key (costs apply)
- Slower than pixel-based methods
- May occasionally misinterpret unusual structures
- Best for clear, well-lit images
- Works best with common object types (figures, vehicles, buildings)

---

## Future Enhancements

- **Caching**: Store validation results to avoid re-checking
- **Confidence scores**: Per-component confidence levels
- **Suggestions**: AI recommendations for improvements
- **3D understanding**: Better depth/occlusion handling
- **Custom components**: User-defined component types
