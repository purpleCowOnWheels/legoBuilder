import { NextResponse } from "next/server";
import { readDb, writeDb } from "@/lib/storage";
import { enqueueLDrawJob } from "@/lib/ldrawQueue";

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
  if (!Array.isArray(search.ideas) || ideaIndex < 0 || ideaIndex >= search.ideas.length) {
    return NextResponse.json({ error: "Invalid ideaIndex" }, { status: 400 });
  }

  try {
    const { job, alreadyRunning } = enqueueLDrawJob({ ideaSearchId: searchId, ideaIndex });
    if (alreadyRunning && job) {
      return NextResponse.json({ jobId: job.id, alreadyRunning: true });
    }
    if (!job) {
      return NextResponse.json({ error: "Job already running" }, { status: 409 });
    }

    // Ensure the idea record points at the job (enqueue already does this, but keep it explicit)
    const db2 = readDb();
    const s2 = db2.ideaSearches.find((s) => s.id === searchId);
    if (s2 && s2.ideas?.[ideaIndex]) {
      s2.ideas[ideaIndex].ldrawJobId = job.id;
      s2.ideas[ideaIndex].ldrawStatus = s2.ideas[ideaIndex].ldrawStatus || "queued";
      s2.updatedAt = new Date().toISOString();
      writeDb(db2);
    }

    return NextResponse.json({ jobId: job.id, alreadyRunning });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to enqueue job" }, { status: 500 });
  }
}


