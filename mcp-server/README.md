# LEGO Builder Validation MCP Server

A Model Context Protocol (MCP) server that exposes **3 high-level validation tools** for LEGO build validation. The MCP server internally determines which checks to run and returns comprehensive results.

## Architecture

```
GPT calls ONE tool  →  MCP runs ALL applicable checks  →  Returns comprehensive report
```

Instead of GPT choosing individual validation methods, it calls a single tool per validation level. The MCP server:
1. Detects what validators are available (Python, OpenAI API, etc.)
2. Runs all applicable checks for that level
3. Returns a bundled report with all results

## Tools

### 1. `validate_step`
**Use during generation** - validates individual steps or chunks.

**Runs these checks automatically:**
- ✓ Syntax validation (FILE/NOFILE, part lines, coordinates)
- ✓ Structure analysis (for non-chunks)
- ✓ Continuity checks (alignment, isolated parts, extreme coords)
- ✓ Connection validation (if Python + numpy available)

```typescript
// Example call
{
  "ldraw_content": "0 STEP\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3020.dat\n0 STEP\n...",
  "mode": "chunk",  // or "partial" or "full"
  "step_from": 1,
  "step_to": 3
}
```

### 2. `validate_submodule`
**Use after completing each subassembly** - validates against blueprint spec.

**Runs these checks automatically:**
- ✓ Structural validation
- ✓ Position validation (is it where the blueprint says it should be?)
- ✓ Symmetry checks (for symmetric subassemblies)
- ✓ Proportion checks
- ✓ Continuity checks
- ✓ Connection validation (if available)
- ✓ Semantic validation via AI vision (if render image provided + OpenAI API available)

```typescript
// Example call
{
  "ldraw_mpd": "0 FILE model.ldr\n...\n0 NOFILE",
  "subassembly_name": "torso",
  "blueprint": { "subassemblies": [...], "step_outline": [...] },
  "render_image_path": "/path/to/partial_render.png",  // optional
  "steps_completed": 6
}
```

### 3. `validate_full`
**Use when model is complete** - final validation with optional reference comparison.

**Runs these checks automatically:**
- ✓ Full structural validation
- ✓ Continuity checks
- ✓ Blueprint compliance (all subassemblies present and positioned)
- ✓ Connection validation (if available)
- ✓ Image similarity SSIM (if reference + render images provided)
- ✓ Semantic similarity via AI vision (if images provided + OpenAI API available)

```typescript
// Example call
{
  "ldraw_mpd": "0 FILE model.ldr\n...\n0 NOFILE",
  "reference_image_path": "/path/to/original.png",
  "render_image_path": "/path/to/rendered.png",
  "blueprint": { "subassemblies": [...], "step_outline": [...] },
  "min_similarity": 60
}
```

## Response Format

All tools return a comprehensive report:

```json
{
  "valid": false,
  "checks_run": ["syntax", "structure", "continuity", "connections"],
  "checks_passed": 3,
  "checks_failed": 1,
  "checks": [
    {
      "name": "syntax",
      "passed": true,
      "details": { "mode": "chunk" }
    },
    {
      "name": "structure",
      "passed": true,
      "details": { "issues": [] }
    },
    {
      "name": "continuity",
      "passed": false,
      "details": { "issues": [...] },
      "error": "2 isolated parts detected"
    },
    {
      "name": "connections",
      "passed": true,
      "score": 95,
      "details": { "connection_count": 47 }
    }
  ],
  "summary": "Step validation FAILED: 1/4 checks failed",
  "recommendations": [
    "Fix 2 isolated parts - ensure all parts connect properly"
  ]
}
```

## Installation

```bash
cd mcp-server
npm install
```

## Usage

**Run MCP server:**
```bash
npm run dev
```

**Test tools directly:**
```bash
npx tsx test-tools.ts
```

**From project root:**
```bash
npm run mcp:dev      # Run server
npm run mcp:install  # Install dependencies
npm run mcp:inspect  # Open MCP inspector
```

## Add to Claude/Cursor

Copy to your MCP config (e.g., `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "lego-validator": {
      "command": "npx",
      "args": ["tsx", "/path/to/legoBuilder/mcp-server/src/index.ts"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

## Capability Detection

The server automatically detects available validators:

| Capability | Requires | Used In |
|------------|----------|---------|
| **Semantic validation** | `OPENAI_API_KEY` + Python 3 | `validate_submodule`, `validate_full` |
| **Connection validation** | Python 3 + numpy | All tools |
| **Image comparison** | Python 3 or ImageMagick | `validate_full` |

Checks that require unavailable capabilities are simply skipped - no errors.

## Workflow Example

```
1. Generate blueprint
   
2. For each chunk:
   → Generate LDraw chunk
   → Call validate_step(mode="chunk")
   → Review all checks, fix issues if any failed

3. After each subassembly:
   → Call validate_submodule(subassembly_name="torso")
   → Review position, symmetry, semantic results

4. When complete:
   → Call validate_full with reference image
   → Review all final checks including similarity scores
```

## Logging

All validations are automatically logged to `data/mcp-logs/` with:
- **Timestamps and sequence numbers** - see the exact progression
- **Stage indicators** - step, submodule, or full
- **Complete inputs** - what GPT sent
- **Full results** - all check outcomes
- **Saved images** - copies of render/reference images

### Log Structure

```
data/mcp-logs/
└── 2026-01-17T12-34-56/           # Session ID (timestamp)
    ├── session.json                # Summary of all entries
    ├── 0001_step_validate_step.json
    ├── 0002_step_validate_step.json
    ├── 0003_submodule_validate_submodule.json
    ├── 0004_full_validate_full.json
    └── images/
        ├── 0003_submodule_render.png
        ├── 0004_full_render.png
        └── 0004_full_reference.png
```

### View Logs

```bash
# Show latest session
npm run mcp:logs

# List all sessions
npm run mcp:logs:list

# Show with images and details
npm run mcp:logs:images

# Show specific session
npx tsx mcp-server/view-logs.ts 2026-01-17T12-34-56
```

### Log Output Example

```
═══════════════════════════════════════════════════════════════════════
Session: 2026-01-17T12-34-56
Started: 2026-01-17T12:34:56.123Z
Entries: 8
═══════════════════════════════════════════════════════════════════════

Summary by Stage:
  STEP       5 validations | 4 passed | 1 failed
  SUBMODULE  2 validations | 2 passed | 0 failed
  FULL       1 validations | 1 passed | 0 failed

Validation Progression:
────────────────────────────────────────────────────────────────────────
#  1 [STEP     ] ▓ PASS ▓ validate_step (234ms)
     ✓syntax ✓structure ✓continuity ✓connections

#  2 [STEP     ] ▓ FAIL ▓ validate_step (189ms)
     ✓syntax ✓structure ✗continuity ✓connections
     → Fix 2 isolated parts - ensure all parts connect properly

#  3 [SUBMODULE] ▓ PASS ▓ validate_submodule (1204ms)
     ✓structure ✓position ✓symmetry ✓continuity ✓semantic
     📷 Render: 0003_submodule_render.png

#  4 [FULL     ] ▓ PASS ▓ validate_full (2341ms)
     ✓structure ✓continuity ✓blueprint_compliance ✓connections ✓image_similarity
     📷 Render: 0004_full_render.png
     📷 Reference: 0004_full_reference.png
```

### Response Metadata

Each validation response includes logging metadata:

```json
{
  "valid": true,
  "checks_run": ["syntax", "structure", "continuity"],
  "summary": "Step validation PASSED",
  "_meta": {
    "session_id": "2026-01-17T12-34-56",
    "sequence": 3,
    "stage": "step",
    "logged_at": "2026-01-17T12:35:12.456Z",
    "duration_ms": 234
  }
}
```
