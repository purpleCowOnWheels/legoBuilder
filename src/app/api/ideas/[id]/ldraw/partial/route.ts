import { NextResponse } from "next/server";
import { readDb } from "@/lib/storage";

export async function GET(req: Request, ctx: { params: { id: string } }) {
  const id = ctx.params.id;
  const url = new URL(req.url);
  const ideaIndexRaw = url.searchParams.get("ideaIndex");
  const ideaIndex = ideaIndexRaw != null ? Number(ideaIndexRaw) : NaN;
  if (!Number.isFinite(ideaIndex) || ideaIndex < 0) {
    return NextResponse.json({ error: "Missing/invalid ideaIndex" }, { status: 400 });
  }

  const db = readDb();
  const search = db.ideaSearches.find((s) => s.id === id);
  if (!search) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const idea = search.ideas?.[Math.floor(ideaIndex)] as any;
  if (!idea) return NextResponse.json({ error: "Idea not found" }, { status: 404 });

  const partial = idea?.ldrawArtifacts?.partial_mpd;
  if (!partial || typeof partial !== "string" || partial.trim().length === 0) {
    return NextResponse.json({ error: "Partial LDraw not available yet" }, { status: 404 });
  }

  const filename = `partial_${id}_${Math.floor(ideaIndex) + 1}.mpd`;
  return new NextResponse(partial, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store"
    }
  });
}


