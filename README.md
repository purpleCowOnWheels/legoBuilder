# legoBuilder
Take in your lego sets, save the parts inventory, and generate new ideas and instruction guides

## Local MVP (sets + inventory)

### Run
1. Install deps:

```bash
npm install
```

2. (Optional) Add Rebrickable API key for real parts lists:
   - Create `.env.local` with:
     - `REBRICKABLE_API_KEY=...`
   - See `env.example` for the full list.
   - Copy `env.example` to `.env.local` and fill in keys.

### OpenAI sanity check (structured outputs)
If you’re hitting API schema errors, you can run a direct OpenAI structured-output test:

```bash
npm run test:openai
```

And for Images API:

```bash
npm run test:openai:image
```

3. Start:

```bash
npm run dev
```

Then open the local URL printed in the terminal.

### What works right now
- **Add set by model number** on `/sets` (uses Rebrickable if configured; otherwise uses a small mock parts list)
- **Inventory auto-updates** when sets are added/removed
- **View inventory** on `/inventory`

### Data storage
Everything is stored locally in `data/db.json`.

