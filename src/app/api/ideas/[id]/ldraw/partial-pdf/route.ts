import { NextResponse } from "next/server";
import { readDb, writeDb } from "@/lib/storage";
import { writeIdeaMpdToDisk, generateInstructionsPdfFromMpd } from "@/lib/lpub3d";

export async function POST(req: Request, ctx: { params: { id: string } }) {
  const id = ctx.params.id;
  const body = (await req.json().catch(() => ({}))) as { ideaIndex?: unknown };
  const ideaIndex = typeof body.ideaIndex === "number" ? body.ideaIndex : Number(body.ideaIndex);
  if (!Number.isFinite(ideaIndex) || ideaIndex < 0) {
    return NextResponse.json({ error: "Missing/invalid ideaIndex" }, { status: 400 });
  }

  const db = readDb();
  const search = db.ideaSearches.find((s) => s.id === id);
  if (!search) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const idx = Math.floor(ideaIndex);
  const idea = search.ideas?.[idx] as any;
  if (!idea) return NextResponse.json({ error: "Idea not found" }, { status: 404 });

  const partialMpd = idea?.ldrawArtifacts?.partial_mpd;
  if (!partialMpd || typeof partialMpd !== "string" || partialMpd.trim().length === 0) {
    return NextResponse.json({ error: "Partial LDraw not available yet" }, { status: 404 });
  }

  // Generate a new PDF on demand. Use a unique baseName to avoid caching/stale artifacts.
  const baseName = `partial_pdf_${id}_${idx + 1}_${Date.now().toString(36)}`;
  const mpdPath = writeIdeaMpdToDisk({ baseName, ldrawMpd: partialMpd });
  const pdf = generateInstructionsPdfFromMpd({ mpdPath, baseName });

  idea.ldrawArtifacts = {
    ...(idea.ldrawArtifacts || {}),
    partial_instructions_pdf: pdf.url,
    partial_pdf_updated_at: new Date().toISOString()
  };
  search.updatedAt = new Date().toISOString();
  writeDb(db);

  return NextResponse.json(
    { url: pdf.url },
    {
      status: 200,
      headers: { "Cache-Control": "no-store" }
    }
  );
}


