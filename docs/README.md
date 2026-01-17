# Validation Tools Documentation

This directory contains documentation for the LEGO LDraw validation tools.

## 📚 Documentation Files

### [INSTALLATION_SUMMARY.md](INSTALLATION_SUMMARY.md)
**Complete installation report** with test results, capabilities matrix, and next steps.

### [VALIDATION_QUICK_START.md](VALIDATION_QUICK_START.md)
**Quick reference guide** with code examples and common use cases.

### [VALIDATION_TOOLS.md](VALIDATION_TOOLS.md)
**Detailed technical guide** covering all validation methods, tools, and integration patterns.

---

## 🎯 What's Installed

| Component | Status | Purpose |
|-----------|--------|---------|
| **ImageMagick** | ✅ Installed | Image comparison (SSIM) |
| **Python scikit-image** | ✅ Installed | Advanced similarity metrics |
| **LDraw validator** | ✅ Built-in | Structure validation |
| **Image comparator** | ✅ Built-in | Similarity scoring |
| **LDInspector** | ⚠️ Optional | Collision detection |
| **LDCad** | ⚠️ Optional | Connection validation |

---

## 🚀 Quick Start

### Run Tests
```bash
# Test image similarity
npx tsx scripts/test-image-similarity.ts

# Test LDraw validation
npx tsx scripts/test-ldraw-validation.ts
```

### Use in Code
```typescript
import { compareImages, validateRenderSimilarity } from "@/lib/imageSimilarity";
import { validateLDrawMpdOrThrow, validateLDrawStructure } from "@/lib/ldrawValidate";

// Validate structure
validateLDrawMpdOrThrow(mpdContent);

// Compare images
const score = compareImages(renderPath, inputPath);
console.log(`Similarity: ${score.overall}%`);
```

---

## 📖 Documentation Index

### For Quick Reference
→ Read **VALIDATION_QUICK_START.md**

### For Complete Setup Information
→ Read **INSTALLATION_SUMMARY.md**

### For Technical Details & Integration
→ Read **VALIDATION_TOOLS.md**

---

## 🔗 External Resources

- **LDInspector**: https://fam-frenz.de/stefan/ldi.html
- **LDCad**: https://www.melkert.net/LDCad/
- **SSIM**: https://en.wikipedia.org/wiki/Structural_similarity_index_measure
- **scikit-image**: https://scikit-image.org/

---

## ✅ Status

All core validation tools are **installed, tested, and working**. Optional tools (LDInspector, LDCad) can be added later for advanced collision and connection validation.

Last updated: 2026-01-17
