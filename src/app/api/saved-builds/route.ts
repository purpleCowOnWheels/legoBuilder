import { NextResponse } from "next/server";
import { readDb, writeDb } from "@/lib/storage";
import { newId } from "@/lib/ids";

export async function GET() {
  const db = readDb();
  return NextResponse.json({ builds: db.savedBuilds });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as null | { ideaSearchId?: string; ideaIndex?: number };
  const ideaSearchId = body?.ideaSearchId;
  const ideaIndex = typeof body?.ideaIndex === "number" ? body.ideaIndex : undefined;
  if (!ideaSearchId || typeof ideaSearchId !== "string") {
    return NextResponse.json({ error: "ideaSearchId is required" }, { status: 400 });
  }
  if (ideaIndex == null || !Number.isFinite(ideaIndex) || ideaIndex < 0) {
    return NextResponse.json({ error: "ideaIndex is required" }, { status: 400 });
  }

  const db = readDb();
  const existing = db.savedBuilds.find(
    (b) => b.sourceIdeaSearchId === ideaSearchId && b.sourceIdeaIndex === ideaIndex
  );
  if (existing) return NextResponse.json({ build: existing });

  const search = db.ideaSearches.find((s) => s.id === ideaSearchId);
  const idea = search?.ideas?.[ideaIndex];
  if (!search || !idea) return NextResponse.json({ error: "Idea not found" }, { status: 404 });
  if (!idea.ldraw_mpd || typeof idea.ldraw_mpd !== "string" || idea.ldraw_mpd.trim().length < 20) {
    return NextResponse.json({ error: "LDraw has not been generated for this idea yet" }, { status: 400 });
  }

  const build = {
    id: newId("saved"),
    createdAt: new Date().toISOString(),
    title: idea.title,
    // For saved builds, we only keep the title and assets (no description/spec needed)
    ldraw_mpd: idea.ldraw_mpd,
    thumbnail: idea.thumbnail ?? null,
    instructions_pdf: (idea as any).instructions_pdf ?? null,
    sourceIdeaSearchId: ideaSearchId,
    sourceIdeaIndex: ideaIndex
  };

  db.savedBuilds.unshift(build);
  writeDb(db);
  return NextResponse.json({ build });
}


