import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });

import { readDb } from "../src/lib/storage";
import { generateBlueprintForIdea } from "../src/lib/openai";

function constraintsToText(search: any) {
  return [
    search.targetPartsMin || search.targetPartsMax
      ? `Target parts range: ${search.targetPartsMin ?? "?"}–${search.targetPartsMax ?? "?"}`
      : "Target parts range: (not specified)",
    search.difficulty ? `Difficulty: ${search.difficulty}` : "Difficulty: (not specified)",
    search.age ? `Age: ${search.age}+` : "Age: (not specified)",
    search.buildTimeMinutes ? `Build time target: ${search.buildTimeMinutes} minutes` : "Build time target: (not specified)"
  ].join("\n");
}

function pickLatestSearch(db: any) {
  const list = Array.isArray(db.ideaSearches) ? db.ideaSearches : [];
  const score = (s: any) =>
    (typeof s?.updatedAt === "string" && Date.parse(s.updatedAt)) ||
    (typeof s?.createdAt === "string" && Date.parse(s.createdAt)) ||
    0;
  return list.sort((a: any, b: any) => score(b) - score(a))[0] || null;
}

// Usage:
//   ./node_modules/.bin/tsx scripts/test-blueprint.ts [ideaSearchId] [ideaIndex]
const [ideaSearchIdArg, ideaIndexRaw] = process.argv.slice(2);

const db = readDb();
const search =
  ideaSearchIdArg != null
    ? db.ideaSearches.find((s: any) => s.id === ideaSearchIdArg) || null
    : pickLatestSearch(db);

if (!search) {
  console.error("No IdeaSearch found. Pass an id: ./node_modules/.bin/tsx scripts/test-blueprint.ts <ideaSearchId> <ideaIndex>");
  process.exit(2);
}

const idx = ideaIndexRaw != null ? Number(ideaIndexRaw) : 0;
if (!Number.isFinite(idx) || idx < 0) {
  console.error("Invalid ideaIndex");
  process.exit(2);
}

const ideaIndex = Math.floor(idx);
const idea = search.ideas?.[ideaIndex];
if (!idea) {
  console.error(`Idea not found at index ${ideaIndex} for search ${search.id}`);
  process.exit(2);
}

const previewUrl = typeof idea.preview_thumbnail === "string" ? idea.preview_thumbnail : "";
const previewImagePath =
  previewUrl.startsWith("/") ? path.join(process.cwd(), "public", previewUrl) : undefined;

console.log("Blueprint test call");
console.log("- searchId:", search.id);
console.log("- ideaIndex:", ideaIndex);
console.log("- OPENAI_MODEL:", process.env.OPENAI_MODEL || "(unset)");
console.log("- REASONING_LEVEL:", process.env.REASONING_LEVEL || "(unset)");
console.log("- previewImagePath:", previewImagePath || "(none)");
if (previewImagePath && !fs.existsSync(previewImagePath)) {
  console.log("  (warning) preview image path does not exist on disk");
}

const t0 = performance.now();
await generateBlueprintForIdea({
  idea: { title: idea.title, description: idea.description, spec: idea.spec },
  inventory: db.inventory,
  preferences: search.preferences,
  constraintsText: constraintsToText(search),
  previewImagePath
});
const t1 = performance.now();

console.log(`Blueprint call completed in ${Math.round(t1 - t0)}ms`);


