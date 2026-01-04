import { NextResponse } from "next/server";
import { readDb, writeDb } from "@/lib/storage";
import { generateThumbnailDataUrl } from "@/lib/openai";

export async function POST(req: Request, ctx: { params: { id: string } }) {
  const id = ctx.params.id;
  const body = (await req.json().catch(() => null)) as null | { index?: number };
  const index = typeof body?.index === "number" ? body.index : -1;
  if (!Number.isInteger(index) || index < 0) {
    return NextResponse.json({ error: "index is required" }, { status: 400 });
  }

  try {
    const db = readDb();
    const search = db.ideaSearches.find((s) => s.id === id);
    if (!search) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const idea = search.ideas[index];
    if (!idea) return NextResponse.json({ error: "Idea not found at index" }, { status: 404 });

    // If already generated, return existing URL
    if (idea.thumbnail) {
      return NextResponse.json({ ok: true, index, thumbnail: idea.thumbnail, imageModel: search.imageModel });
    }

    const { url, imageModel } = await generateThumbnailDataUrl({ prompt: idea.thumbnail_prompt });
    idea.thumbnail = url;
    search.imageModel = imageModel;
    writeDb(db);

    return NextResponse.json({ ok: true, index, thumbnail: url, imageModel });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to generate thumbnail" },
      { status: 500 }
    );
  }
}


