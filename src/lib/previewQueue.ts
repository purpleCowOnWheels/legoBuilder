import { readDb, writeDb } from "@/lib/storage";
import { newId } from "@/lib/ids";
import type { PreviewGenerationJob, PreviewJobLogEvent, IdeaCandidate } from "@/lib/models";
import { generatePreviewMpdForIdea } from "@/lib/openai";
import { validateLDrawMpdOrThrow } from "@/lib/ldrawValidate";
import { generateThumbnailPngFromMpd, writeIdeaMpdToDisk } from "@/lib/lpub3d";

const inMemoryQueue: string[] = []; // job ids
let workerRunning = false;

function now() {
  return new Date().toISOString();
}

function pushLog(job: PreviewGenerationJob, event: Omit<PreviewJobLogEvent, "at">) {
  job.logs.push({ at: now(), ...event });
  if (job.logs.length > 120) job.logs.splice(0, job.logs.length - 120);
}

export function createPreviewJob(params: { ideaSearchId: string; ideaIndex: number }): PreviewGenerationJob {
  const at = now();
  return {
    id: newId("previewjob"),
    ideaSearchId: params.ideaSearchId,
    ideaIndex: params.ideaIndex,
    status: "queued",
    stage: "openai",
    createdAt: at,
    updatedAt: at,
    logs: [{ at, type: "queued", message: "Preview job queued" }]
  };
}

export function enqueuePreviewJob(params: { ideaSearchId: string; ideaIndex: number }) {
  const db = readDb();
  const search = db.ideaSearches.find((s) => s.id === params.ideaSearchId);
  if (!search) throw new Error("Idea search not found");
  const idea = search.ideas?.[params.ideaIndex] as IdeaCandidate | undefined;
  if (!idea) throw new Error("Idea not found");

  if (idea.previewStatus === "running" || idea.previewStatus === "queued") {
    return { job: db.previewGenerationJobs.find((j) => j.id === idea.previewJobId) || null, alreadyRunning: true };
  }
  if (idea.previewStatus === "done" && idea.preview_thumbnail) {
    return { job: db.previewGenerationJobs.find((j) => j.id === idea.previewJobId) || null, alreadyRunning: true };
  }

  const job = createPreviewJob(params);
  db.previewGenerationJobs.unshift(job);

  idea.previewStatus = "queued";
  idea.previewJobId = job.id;
  idea.previewError = undefined;
  search.updatedAt = now();
  writeDb(db);

  inMemoryQueue.push(job.id);
  void runWorker();
  return { job, alreadyRunning: false };
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (inMemoryQueue.length > 0) {
      const jobId = inMemoryQueue.shift();
      if (!jobId) continue;

      const db = readDb();
      const job = db.previewGenerationJobs.find((j) => j.id === jobId);
      if (!job) continue;
      if (job.status !== "queued") continue;

      const search = db.ideaSearches.find((s) => s.id === job.ideaSearchId);
      const idea = search?.ideas?.[job.ideaIndex] as IdeaCandidate | undefined;
      if (!search || !idea) {
        job.status = "error";
        job.stage = "done";
        job.error = "Missing search/idea for preview job";
        job.updatedAt = now();
        job.finishedAt = job.updatedAt;
        pushLog(job, { type: "error", message: job.error });
        writeDb(db);
        continue;
      }

      const startedAt = now();
      job.status = "running";
      job.stage = "openai";
      job.startedAt = startedAt;
      job.updatedAt = startedAt;
      pushLog(job, { type: "started", message: "Preview job started" });
      idea.previewStatus = "running";
      idea.previewError = undefined;
      search.updatedAt = startedAt;
      writeDb(db);

      const heartbeat = setInterval(() => {
        try {
          const dbH = readDb();
          const j = dbH.previewGenerationJobs.find((x) => x.id === jobId);
          const s = dbH.ideaSearches.find((x) => x.id === (j?.ideaSearchId || ""));
          const i = s?.ideas?.[j?.ideaIndex ?? -1] as IdeaCandidate | undefined;
          if (!j || j.status !== "running") return;
          const at = now();
          j.updatedAt = at;
          pushLog(j, { type: "heartbeat", message: "Generating preview…" });
          if (s) s.updatedAt = at;
          if (i && i.previewStatus === "running") i.previewStatus = "running";
          writeDb(dbH);
        } catch {
          // ignore
        }
      }, 8000);

      try {
        pushLog(job, { type: "openai", message: "Generating micro MPD (preview) via OpenAI…" });

        const { ldraw_mpd } = await generatePreviewMpdForIdea({
          inventory: db.inventory,
          idea: { title: idea.title, description: idea.description, spec: idea.spec }
        });

        // Minimal validation before rendering thumbnail
        validateLDrawMpdOrThrow({ ldrawMpd: ldraw_mpd });

        job.stage = "thumbnail";
        job.updatedAt = now();
        pushLog(job, { type: "lpub3d", message: "Rendering preview thumbnail via LPub3D…" });

        const baseName = `preview_${search.id}_${job.ideaIndex + 1}`;
        const mpdPath = writeIdeaMpdToDisk({ baseName, ldrawMpd: ldraw_mpd });
        const thumb = generateThumbnailPngFromMpd({ mpdPath, baseName, size: 768 });

        const dbDone = readDb();
        const sDone = dbDone.ideaSearches.find((s) => s.id === job.ideaSearchId);
        const jDone = dbDone.previewGenerationJobs.find((j) => j.id === jobId);
        const iDone = sDone?.ideas?.[job.ideaIndex] as IdeaCandidate | undefined;
        if (!sDone || !jDone || !iDone) throw new Error("Missing search/job/idea after preview generation");

        iDone.preview_mpd = ldraw_mpd;
        iDone.preview_thumbnail = thumb.url;
        iDone.previewStatus = "done";
        iDone.previewError = undefined;
        sDone.updatedAt = now();

        jDone.status = "done";
        jDone.stage = "done";
        jDone.updatedAt = sDone.updatedAt!;
        jDone.finishedAt = jDone.updatedAt;
        pushLog(jDone, { type: "done", message: "Preview complete" });
        writeDb(dbDone);
      } catch (e) {
        const dbErr = readDb();
        const jErr = dbErr.previewGenerationJobs.find((x) => x.id === jobId);
        const sErr = dbErr.ideaSearches.find((x) => x.id === (jErr?.ideaSearchId || ""));
        const iErr = sErr?.ideas?.[jErr?.ideaIndex ?? -1] as IdeaCandidate | undefined;
        const msg = e instanceof Error ? e.message : "Preview generation failed";
        const at = now();
        if (jErr) {
          jErr.status = "error";
          jErr.stage = "done";
          jErr.error = msg;
          jErr.updatedAt = at;
          jErr.finishedAt = at;
          pushLog(jErr, { type: "error", message: msg });
        }
        if (sErr) sErr.updatedAt = at;
        if (iErr) {
          iErr.previewStatus = "error";
          iErr.previewError = msg;
        }
        writeDb(dbErr);
      } finally {
        clearInterval(heartbeat);
      }
    }
  } finally {
    workerRunning = false;
  }
}


