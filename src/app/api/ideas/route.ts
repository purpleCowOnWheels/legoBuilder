import { NextResponse } from "next/server";
import { readDb, writeDb } from "@/lib/storage";
import { newId } from "@/lib/ids";
import { enqueueIdeaJob } from "@/lib/ideaQueue";

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
    count?: number;
  };
  const preferences = body?.preferences;
  const targetPartsMin = typeof body?.targetPartsMin === "number" ? body?.targetPartsMin : undefined;
  const targetPartsMax = typeof body?.targetPartsMax === "number" ? body?.targetPartsMax : undefined;
  const difficulty = body?.difficulty;
  const age = typeof body?.age === "number" ? body?.age : undefined;
  const buildTimeMinutes = typeof body?.buildTimeMinutes === "number" ? body?.buildTimeMinutes : undefined;
  const count = typeof body?.count === "number" ? Math.floor(body.count) : undefined;

  const db = readDb();
  if (db.inventory.length === 0) {
    return NextResponse.json(
      { error: "Your inventory is empty. Add a set first so we have parts to work with." },
      { status: 400 }
    );
  }

  try {
    const now = new Date().toISOString();
    const searchId = newId("idea");
    const updatedDb = readDb();
    updatedDb.ideaSearches.unshift({
      id: searchId,
      createdAt: now,
      preferences: preferences?.trim() || undefined,
      targetPartsMin,
      targetPartsMax,
      difficulty,
      age,
      buildTimeMinutes,
      count,
      status: "queued",
      updatedAt: now,
      ideas: []
    });
    writeDb(updatedDb);

    const job = enqueueIdeaJob(searchId);
    // Link job back to the search
    const db2 = readDb();
    const s2 = db2.ideaSearches.find((s) => s.id === searchId);
    if (s2) {
      s2.jobId = job.id;
      s2.updatedAt = new Date().toISOString();
      writeDb(db2);
    }

    // Return immediately; UI will poll status.
    return NextResponse.json({ searchId, jobId: job.id });
  } catch (e) {
    // Surface debugId in errors (if enabled) so you can find artifacts under data/openai-debug/.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to generate ideas" },
      { status: 500 }
    );
  }
}


