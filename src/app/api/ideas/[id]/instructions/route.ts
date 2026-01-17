import { NextResponse } from "next/server";
import { readDb } from "@/lib/storage";
import fs from "node:fs";
import path from "node:path";

function urlToPublicFilePath(url: string) {
  const cleaned = String(url || "").trim();
  if (!cleaned.startsWith("/")) throw new Error("Invalid asset url");
  // Only allow serving files from /public.
  const fullPath = path.join(process.cwd(), "public", cleaned);
  const normalized = path.normalize(fullPath);
  const publicRoot = path.normalize(path.join(process.cwd(), "public")) + path.sep;
  if (!normalized.startsWith(publicRoot)) throw new Error("Invalid asset path");
  return normalized;
}

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
  const idx = Math.floor(ideaIndex);
  const idea = search.ideas?.[idx] as any;
  if (!idea) return NextResponse.json({ error: "Idea not found" }, { status: 404 });

  const partialUrl = idea?.ldrawArtifacts?.partial_instructions_pdf as string | undefined;
  const finalUrl = idea?.instructions_pdf as string | undefined;
  const isPartialPreferred = idea?.ldrawStatus === "queued" || idea?.ldrawStatus === "running";
  const selectedUrl = (isPartialPreferred ? partialUrl : undefined) || finalUrl || partialUrl;
  if (!selectedUrl) {
    return NextResponse.json({ error: "Instructions not available yet" }, { status: 404 });
  }

  let filePath: string;
  try {
    filePath = urlToPublicFilePath(selectedUrl);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Invalid instructions path" }, { status: 400 });
  }

  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "Instructions file missing on disk" }, { status: 404 });
  }

  const buf = fs.readFileSync(filePath);
  const partial = selectedUrl === partialUrl;
  const filename = `instructions_${id}_${idx + 1}_${partial ? "partial" : "final"}.pdf`;
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store"
    }
  });
}


