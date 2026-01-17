import { NextResponse } from "next/server";
import { readDb, writeDb } from "@/lib/storage";

export async function GET(_: Request, ctx: { params: { id: string } }) {
  const id = ctx.params.id;
  const db = readDb();
  const search = db.ideaSearches.find((s) => s.id === id);
  if (!search) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const ideationJob = search.jobId ? db.ideaGenerationJobs.find((j) => j.id === search.jobId) : null;
  const ldrawJobs = db.ldrawGenerationJobs.filter((j) => j.ideaSearchId === id);
  const previewJobs = db.previewGenerationJobs.filter((j) => j.ideaSearchId === id);
  return NextResponse.json({ search, ideationJob, previewJobs, ldrawJobs, debugOpenAi: process.env.DEBUG_OPENAI === "1" });
}

export async function DELETE(_: Request, ctx: { params: { id: string } }) {
  const id = ctx.params.id;
  const db = readDb();
  const before = db.ideaSearches.length;
  db.ideaSearches = db.ideaSearches.filter((s) => s.id !== id);
  if (db.ideaSearches.length === before) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  writeDb(db);
  return NextResponse.json({ ok: true });
}


