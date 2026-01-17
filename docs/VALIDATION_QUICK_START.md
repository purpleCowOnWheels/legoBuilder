# Validation Tools - Quick Reference

## ✅ Installed & Ready

### 1. Image Similarity (Python SSIM)
**Status**: ✅ Fully working  
**Best accuracy** using scikit-image 0.26.0

```typescript
import { compareImages } from "@/lib/imageSimilarity";

const score = compareImages(renderPath, inputImagePath);
console.log(`Similarity: ${score.overall}%`);
// score.metrics.ssim, score.metrics.mse, score.metrics.psnr
```

### 2. Image Similarity (ImageMagick)
**Status**: ✅ Backup method  
ImageMagick 7.1.2-12 installed

### 3. LDraw Structure Validation
**Status**: ✅ Fully working  
Built-in validation

```typescript
import { validateLDrawMpdOrThrow, validateLDrawStructure } from "@/lib/ldrawValidate";

// Quick check (throws on error)
validateLDrawMpdOrThrow(mpdContent);

// Detailed results
const result = validateLDrawStructure(mpdContent);
```

## ⚠️ Optional (Not Installed)

### LDInspector (Collision Detection)
**Status**: ⚠️ Not installed  
**Download**: https://fam-frenz.de/stefan/ldi.html

```bash
# After installing, add to .env.local:
LDINSPECTOR_BIN=/Applications/LDInspector.app/Contents/MacOS/LDInspector
```

### LDCad Shadow Library
**Status**: ⚠️ Not installed  
**Purpose**: Connection validation, snap points  
**Download**: https://www.melkert.net/LDCad/

## 🧪 Test Commands

```bash
# Test image similarity (requires 2+ thumbnails)
npx tsx scripts/test-image-similarity.ts

# Test LDraw validation (requires manual MPD files)
npx tsx scripts/test-ldraw-validation.ts
```

## 📊 Current Capabilities

| Validation Type | Status | Method |
|----------------|--------|---------|
| Syntax errors | ✅ | Built-in |
| Structure validation | ✅ | Built-in |
| Image similarity (SSIM) | ✅ | Python scikit-image |
| Image similarity (backup) | ✅ | ImageMagick |
| Collision detection | ⚠️ | LDInspector (not installed) |
| Connection validation | ⚠️ | LDCad (not installed) |

## 🚀 Usage in Pipeline

```typescript
// Example: Validate after generating MPD
try {
  // 1. Syntax check
  validateLDrawMpdOrThrow(mpdContent);
  
  // 2. Generate render
  const { url: renderPath } = generateThumbnailPngFromMpd({...});
  
  // 3. Compare to input
  const similarity = compareImages(renderPath, inputImagePath);
  
  if (similarity.overall < 70) {
    throw new Error(`Render similarity too low: ${similarity.overall}%`);
  }
  
  // 4. Collision check (if installed)
  if (process.env.LDINSPECTOR_BIN) {
    const collisions = runLDInspector(mpdPath);
    // Handle collision results...
  }
  
} catch (error) {
  // Handle validation failure
}
```

## 📁 File Locations

- **Image similarity**: `src/lib/imageSimilarity.ts`
- **LDraw validation**: `src/lib/ldrawValidate.ts`
- **Test scripts**: `scripts/test-*.ts`
- **Documentation**: `docs/VALIDATION_TOOLS.md`
- **Config**: `env.example` (updated)

## ✨ What's Working

✅ **Image Similarity**  
- Python SSIM (0.8084 similarity between two different LEGO models)
- Self-comparison returns 100% as expected
- Threshold validation working

✅ **LDraw Validation**  
- All 6 manual MPD files validated successfully
- Structure checks passing
- No syntax errors detected

## 🔧 Next Steps (If Needed)

1. **Install LDInspector** for collision detection
2. **Install LDCad** for connection validation
3. **Integrate into pipeline** (`ldrawQueue.ts`)
4. **Add validation events** to job logging
5. **Set up automatic rejection** of invalid models
