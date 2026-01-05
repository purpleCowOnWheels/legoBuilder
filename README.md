# legoBuilder
Local web app to manage LEGO sets/parts inventory and generate **build ideas** as **LDraw MPD** + **LPub3D-generated** thumbnails and instruction PDFs.

## What it does
- **Sets & Inventory**
  - Add a set by model number on `/sets` (uses Rebrickable when configured; otherwise falls back to a small mock list)
  - Inventory auto-updates when sets are added/removed
  - View aggregated inventory on `/inventory`
- **Build Ideas (LDraw + LPub3D)**
  - On `/ideas`, generates up to **2 ideas** based on your inventory
  - Each idea includes:
    - `ldraw_mpd` (full model in MPD format with `0 STEP`)
    - a **thumbnail PNG** rendered via **LPub3D**
    - an **instructions PDF** exported via **LPub3D**
  - Idea generation runs as a **background job** so you can refresh/navigate away; the UI polls status every ~15s.
- **Saved Builds**
  - Click the **heart** on any idea to save it
  - Browse saved items on `/saved-builds` (download PDF + LDraw, unfavorite)

## Setup

### 1) Install dependencies
From the repo root:

```bash
npm install
```

### 2) Install LPub3D (required for thumbnails + PDFs)
This app uses the **LPub3D CLI** to render thumbnails and export instruction PDFs.

- Install LPub3D to **`/Applications/LPub3D.app`** (macOS), or set `LPUB3D_BIN` to the LPub3D executable.
- Verify:

```bash
"/Applications/LPub3D.app/Contents/MacOS/LPub3D" --help
```

#### LDraw parts library (recommended)
LPub3D works best when the LDraw library is installed and configured.

- Set `LDRAWDIR` in your environment (LPub3D prints the expected location in `--help` output).
- If you see “missing parts/files” errors, this is usually the cause.

### 3) Configure `.env.local`
Copy `env.example` → `.env.local` and fill in values:

- **Required for Ideas**
  - `OPENAI_API_KEY`
  - `OPENAI_MODEL`
  - `REASONING_LEVEL` (e.g. `low | medium | high`)
  - `OPENAI_MAX_OUTPUT_TOKENS` (e.g. `12000`) — required to avoid truncating LDraw MPD outputs
- **Optional**
  - `REBRICKABLE_API_KEY` (recommended for real set part lists)
  - `LPUB3D_BIN` (if LPub3D isn’t at `/Applications/LPub3D.app/Contents/MacOS/LPub3D`)
  - `LDRAWDIR` (path to your LDraw library)
  - `DEBUG_OPENAI=1` (writes debug artifacts to `data/openai-debug/`)

## Run
Start the dev server:

```bash
npm run dev
```

Then open the local URL printed in the terminal.

## How the “tool” runs (idea generation pipeline)
When you click “Generate ideas” on `/ideas`:

1. The server creates an `IdeaSearch` record and an `IdeaGenerationJob`.
2. A background worker runs:
   - **OpenAI**: generates candidate ideas with `ldraw_mpd`.
   - **Validation tool loop**: OpenAI is required to call `validate_ldraw_mpd` and retry until the MPD passes (capped).
   - **LPub3D**:
     - renders a final-step thumbnail PNG into `public/generated-thumbs/`
     - exports a PDF into `public/generated-instructions/`
3. The UI polls `/api/ideas/:id` every ~15s and updates when results are ready.

Artifacts:
- `data/db.json`: persistence for sets, inventory, searches, jobs, saved builds
- `data/ldraw/`: MPD files written for LPub3D runs
- `public/generated-thumbs/`: thumbnails
- `public/generated-instructions/`: PDFs

## OpenAI sanity check (structured outputs)
If you’re hitting API/schema errors, you can run a direct OpenAI structured-output test:

```bash
npm run test:openai
```

## Notes / troubleshooting
- **Generation feels slow**: it may take multiple OpenAI validation retries + LPub3D export. While running, the job writes a heartbeat to the DB every ~15 seconds.
- **LPub3D errors about missing parts**: install/configure the LDraw library (`LDRAWDIR`), or LPub3D can’t resolve part files.

