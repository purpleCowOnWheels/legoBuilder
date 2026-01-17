# LDraw Rendering Options

## Current Issue: LPub3D Brittleness on macOS

LPub3D is designed for **instruction PDF generation**, not lightweight validation rendering. On macOS, it can hang due to GUI framework (Qt/Cocoa) initialization even when run from command line.

**Symptoms:**
- Renders hang indefinitely (15s timeout doesn't always work)
- `SIGABRT` crashes on simple models
- `QT_QPA_PLATFORM` issues on macOS
- Process needs to be force-killed

## Rendering Tools Comparison

| Tool | Purpose | Stability | Speed | Headless | Best For |
|------|---------|-----------|-------|----------|----------|
| **LDView** | Single-frame viewer | ⭐⭐⭐⭐⭐ Excellent | ⭐⭐⭐⭐⭐ Very Fast | ✅ Yes | **Validation renders** |
| **LPub3D** | Instruction PDFs | ⭐⭐ Poor on macOS | ⭐⭐ Slow | ⚠️ GUI issues | Final instruction PDFs |
| **LeoCAD** | Editor/builder | ⭐⭐ Hangs on macOS | ⭐⭐⭐ Fast | ⚠️ GUI issues | Interactive editing only |
| **ldraw-python** | Python library | ⭐⭐⭐ Good | ⭐⭐⭐ Medium | ✅ Yes | Custom rendering scripts |
| **Blender + LDraw** | 3D rendering | ⭐⭐⭐⭐ Good | ⭐ Slow | ✅ Yes | High-quality final renders |

## Current Implementation

```typescript
// src/lib/renderValidation.ts - renderMpdToPng()

Priority order:
1. LDView - if installed (most stable)
2. LPub3D - fallback (can hang)
```

### Timeout Settings
- **15 seconds** for simple validation renders
- Aggressive to fail fast on hangs
- Works for simple models (<50 pieces)
- May need increase for complex models (>200 pieces)

## Recommended Solutions

### Option 1: Install LDView (RECOMMENDED) ✅ INSTALLED

**Pros:**
- ✅ Designed for headless rendering
- ✅ No GUI hang issues
- ✅ Fast and stable (~500ms per render)
- ✅ Pure CLI tool, no GUI components
- ✅ Already integrated as first choice

**Status:** ✅ **Installed and working** (`/Applications/LDView.app`)

**Installation (if needed on other machines):**
1. Download from: https://github.com/tcobbs/ldview/releases
2. Download `LDView_4.6.dmg` (or latest version)
3. Mount DMG and copy `LDView.app` to `/Applications/`
4. No environment variable needed (auto-detected)

### Option 2: Skip Intermediate Renders

Only render the **final build**, not every chunk. This reduces LPub3D usage by 80-90%.

**Changes needed:**
- Set `visualFeedbackMode: "final_only"` (already implemented)
- Rely on syntax/structure validation for chunks
- Only do similarity checking on final model

**Pros:**
- ✅ Reduces LPub3D usage
- ✅ Faster validation loop
- ✅ Lower cost (fewer GPT vision calls)

**Cons:**
- ❌ GPT doesn't see visual progress until the end
- ❌ Errors caught later in process

### Option 3: Docker + Headless Rendering

Run LDView/LPub3D in a Linux container with proper X server.

**Pros:**
- ✅ True headless rendering
- ✅ No macOS GUI issues
- ✅ Reproducible environment

**Cons:**
- ❌ Requires Docker setup
- ❌ Slower (container overhead)
- ❌ More complex deployment

**Example:**
```dockerfile
FROM ubuntu:22.04
RUN apt-get update && apt-get install -y \
    ldview \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

# Run with virtual framebuffer
ENTRYPOINT ["xvfb-run", "-a", "ldview"]
```

### Option 4: Python-based Rendering

Use `ldraw-python` + `PIL` for basic wireframe/preview renders.

**Pros:**
- ✅ Pure Python (no external binaries)
- ✅ Scriptable and customizable
- ✅ No GUI issues

**Cons:**
- ❌ Lower quality renders
- ❌ Requires implementation
- ❌ May not handle all LDraw features

## Current Workarounds

**Implemented:**
1. ✅ 15-second aggressive timeout
2. ✅ Orphan process cleanup
3. ✅ LDView as first choice (when available)
4. ✅ Retry logic with delays
5. ✅ Pre-render syntax validation (fast-fail before render)

**Recommended next step:**
- Install LDView manually for your macOS system
- Set `LDVIEW_BIN` environment variable if needed

## Usage for Different Scenarios

### During Development/Validation
**Best:** LDView (install it!)  
**Fallback:** LPub3D with aggressive timeout

### Final Instruction PDF Generation
**Use:** LPub3D  
**Why:** It's designed for this, generates proper step-by-step layouts

### Production/Server
**Best:** Docker + LDView with xvfb  
**Why:** Most reliable headless setup

## Environment Variables

```bash
# ~/.zshrc or project .env file
export LDVIEW_BIN=/Applications/LDView.app/Contents/MacOS/LDView
export LPUB3D_BIN=/Applications/LPub3D.app/Contents/MacOS/LPub3D
export LPUB3D_MAX_CONCURRENT=1  # Prevent multiple hangs
```

## Testing Rendering

```bash
# Test LDView (if installed)
/Applications/LDView.app/Contents/MacOS/LDView \
  test.mpd \
  -SaveSnapshot=test.png \
  -SaveWidth=800 \
  -SaveHeight=800

# Test LPub3D (may hang)
timeout 15s /Applications/LPub3D.app/Contents/MacOS/LPub3D \
  --liblego \
  -i test.png \
  -w 800 \
  -h 800 \
  --from 1 \
  --to 1 \
  test.mpd
```

## Summary

**Current state:** ✅ **LDView 4.6 installed and working!**  
**Rendering:** LDView for validation (~500ms), LPub3D only for final PDFs  
**Status:** Stable, no more GUI hangs during validation  
**Production:** Ready to use, consider Docker for server deployments
