import { NextResponse } from "next/server";
import { readDb, writeDb } from "@/lib/storage";

function now() {
  return new Date().toISOString();
}

export async function POST(req: Request, ctx: { params: { id: string } }) {
  const searchId = ctx.params.id;
  const body = (await req.json().catch(() => null)) as null | { ideaIndex?: number };
  const ideaIndex = typeof body?.ideaIndex === "number" ? Math.floor(body.ideaIndex) : NaN;
  if (!Number.isFinite(ideaIndex)) {
    return NextResponse.json({ error: "ideaIndex is required" }, { status: 400 });
  }

  const db = readDb();
  const search = db.ideaSearches.find((s) => s.id === searchId);
  if (!search) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const idea = search.ideas?.[ideaIndex] as any;
  if (!idea) return NextResponse.json({ error: "Idea not found" }, { status: 404 });

  const jobId = idea.ldrawJobId as string | undefined;
  if (!jobId) {
    // Nothing to cancel; mark idea as cancelled for UX anyway.
    idea.ldrawStatus = "cancelled";
    idea.ldrawError = "Cancelled by user";
    search.updatedAt = now();
    writeDb(db);
    return NextResponse.json({ ok: true, jobId: null });
  }

  const job = db.ldrawGenerationJobs.find((j) => j.id === jobId);
  const at = now();
  if (job) {
    job.cancelRequestedAt = job.cancelRequestedAt || at;
    job.status = "cancelled";
    job.stage = "done";
    job.error = "Cancelled by user";
    job.updatedAt = at;
    job.cancelledAt = at;
    job.finishedAt = at;
    job.logs.push({ at, type: "error", message: "Cancelled by user" });
  }

  idea.ldrawStatus = "cancelled";
  idea.ldrawError = "Cancelled by user";
  search.updatedAt = at;
  writeDb(db);
  return NextResponse.json({ ok: true, jobId });
}


