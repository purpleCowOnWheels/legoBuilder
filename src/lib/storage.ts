import fs from "node:fs";
import path from "node:path";
import { DbShape } from "@/lib/models";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const DB_SEED_FILE = path.join(DATA_DIR, "db.seed.json");

function ensureDbFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) return;
  const seed = fs.existsSync(DB_SEED_FILE)
    ? fs.readFileSync(DB_SEED_FILE, "utf8")
    : JSON.stringify({ sets: [], inventory: [], builds: [] }, null, 2);
  fs.writeFileSync(DB_FILE, seed, "utf8");
}

export function readDb(): DbShape {
  ensureDbFile();
  const raw = fs.readFileSync(DB_FILE, "utf8");
  const parsed = JSON.parse(raw) as Partial<DbShape>;
  // Be tolerant of schema changes as we iterate locally.
  return {
    sets: parsed.sets ?? [],
    inventory: parsed.inventory ?? [],
    builds: parsed.builds ?? [],
    ideaSearches: parsed.ideaSearches ?? [],
    ideaGenerationJobs: parsed.ideaGenerationJobs ?? [],
    ldrawGenerationJobs: (parsed as any).ldrawGenerationJobs ?? [],
    previewGenerationJobs: (parsed as any).previewGenerationJobs ?? [],
    savedBuilds: parsed.savedBuilds ?? []
  };
}

export function writeDb(db: DbShape) {
  ensureDbFile();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}


