import { NextResponse } from "next/server";
import { readDb, writeDb } from "@/lib/storage";
import { BuildIdea, generateBuildIdeasStructured } from "@/lib/openai";
import { newId } from "@/lib/ids";

export async function GET() {
  const db = readDb();
  return NextResponse.json({ history: db.ideaSearches });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as null | {
    preferences?: string;
    targetPartsMin?: number;
    targetPartsMax?: number;
    difficulty?: "easy" | "medium" | "hard";
    age?: number;
    buildTimeMinutes?: number;
  };
  const preferences = body?.preferences;
  const targetPartsMin = typeof body?.targetPartsMin === "number" ? body?.targetPartsMin : undefined;
  const targetPartsMax = typeof body?.targetPartsMax === "number" ? body?.targetPartsMax : undefined;
  const difficulty = body?.difficulty;
  const age = typeof body?.age === "number" ? body?.age : undefined;
  const buildTimeMinutes = typeof body?.buildTimeMinutes === "number" ? body?.buildTimeMinutes : undefined;

  const db = readDb();
  if (db.inventory.length === 0) {
    return NextResponse.json(
      { error: "Your inventory is empty. Add a set first so we have parts to work with." },
      { status: 400 }
    );
  }

  try {
    const { ideas, model } = await generateBuildIdeasStructured({
      inventory: db.inventory,
      preferences,
      targetPartsMin,
      targetPartsMax,
      difficulty,
      age,
      buildTimeMinutes
    });

    // No thumbnails yet; each idea can be generated on demand.
    const withThumbs: Array<BuildIdea & { thumbnail: string | null }> = ideas
      .slice(0, 2)
      .map((idea) => ({ ...idea, thumbnail: null }));

    // Persist search + results
    const now = new Date().toISOString();
    const updatedDb = readDb();
    const searchId = newId("idea");
    updatedDb.ideaSearches.unshift({
      id: searchId,
      createdAt: now,
      preferences: preferences?.trim() || undefined,
      targetPartsMin,
      targetPartsMax,
      difficulty,
      age,
      buildTimeMinutes,
      model,
      imageModel: undefined,
      ideas: withThumbs
    });
    writeDb(updatedDb);

    return NextResponse.json({ ideas: withThumbs, model, searchId });
  } catch (e) {
    // Surface debugId in errors (if enabled) so you can find artifacts under data/openai-debug/.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to generate ideas" },
      { status: 500 }
    );
  }
}


