import { readDb, writeDb } from "@/lib/storage";
import { newId } from "@/lib/ids";
import type { IdeaGenerationJob, IdeaJobLogEvent } from "@/lib/models";
import { generatePreviewImagesFromPrompt, extractTitleFromPrompt } from "@/lib/openai";
import { config } from "dotenv";
import path from "node:path";

// Load .env.local explicitly (Next.js API routes auto-load it, but background workers don't)
config({ path: path.join(process.cwd(), ".env.local") });
import { writeGeneratedThumbPng } from "@/lib/generatedAssets";

const inMemoryQueue: string[] = []; // job ids
let workerRunning = false;

function now() {
  return new Date().toISOString();
}

function pushLog(job: IdeaGenerationJob, event: Omit<IdeaJobLogEvent, "at">) {
  job.logs.push({ at: now(), ...event });
  // cap log size to keep db.json manageable
  if (job.logs.length > 200) job.logs.splice(0, job.logs.length - 200);
}

export function createIdeaJob(params: {
  ideaSearchId: string;
}): IdeaGenerationJob {
  const at = now();
  return {
    id: newId("ideajob"),
    ideaSearchId: params.ideaSearchId,
    status: "queued",
    stage: "openai",
    createdAt: at,
    updatedAt: at,
    logs: [{ at, type: "queued", message: "Job queued" }]
  };
}

export function enqueueIdeaJob(ideaSearchId: string) {
  const db = readDb();
  const job = createIdeaJob({ ideaSearchId });
  db.ideaGenerationJobs.unshift(job);
  writeDb(db);
  inMemoryQueue.push(job.id);
  void runWorker();
  return job;
}

export function getIdeaJob(jobId: string) {
  const db = readDb();
  return db.ideaGenerationJobs.find((j) => j.id === jobId) || null;
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (inMemoryQueue.length > 0) {
      const jobId = inMemoryQueue.shift();
      if (!jobId) continue;

      const db = readDb();
      const job = db.ideaGenerationJobs.find((j) => j.id === jobId);
      if (!job) continue;
      if (job.status !== "queued") continue;

      const search = db.ideaSearches.find((s) => s.id === job.ideaSearchId);
      if (!search) {
        job.status = "error";
        job.error = "Missing idea search for job";
        job.stage = "done";
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
      pushLog(job, { type: "started", message: "Job started" });

      search.status = "running";
      search.jobId = job.id;
      search.updatedAt = startedAt;
      search.error = undefined;
      writeDb(db);

      // Heartbeat so UI can confirm "still running" even while awaiting OpenAI.
      const heartbeat = setInterval(() => {
        try {
          const dbH = readDb();
          const j = dbH.ideaGenerationJobs.find((x) => x.id === jobId);
          const s = dbH.ideaSearches.find((x) => x.id === (j?.ideaSearchId || ""));
          if (!j || j.status !== "running") return;
          const at = now();
          j.updatedAt = at;
          pushLog(j, { type: "heartbeat", message: "Ideating..." });
          if (s) s.updatedAt = at;
          writeDb(dbH);
        } catch {
          // ignore heartbeat errors
        }
      }, 15000);

      try {
        // Re-read latest params from search (so we persist exact user inputs).
        const db2 = readDb();
        const s2 = db2.ideaSearches.find((s) => s.id === job.ideaSearchId);
        if (!s2) throw new Error("Idea search missing during execution");

        const count = s2.count ?? 2;
        pushLog(job, {
          type: "openai_round_start",
          message: `Generating ${count} preview image(s) directly from user prompt…`
        });
        writeDb(db2);

        // Step 1: Generate N preview images from the user's original prompt
        const images = await generatePreviewImagesFromPrompt({
          userPrompt: s2.preferences || "A fun LEGO build",
          constraints: {
            targetPartsMin: s2.targetPartsMin,
            targetPartsMax: s2.targetPartsMax,
            difficulty: s2.difficulty,
            age: s2.age,
            buildTimeMinutes: s2.buildTimeMinutes
          },
          count
        });

        pushLog(job, { type: "openai_round_done", message: `${images.length} preview image(s) generated` });

        // Step 2: Extract a short title (single lightweight call, or use first image's revised_prompt)
        pushLog(job, { type: "openai_round_start", message: "Extracting title…" });
        const title = await extractTitleFromPrompt({ userPrompt: s2.preferences || "A fun LEGO build" });
        pushLog(job, { type: "openai_round_done", message: `Title extracted: "${title}"` });

        const db3 = readDb();
        const j3 = db3.ideaGenerationJobs.find((x) => x.id === jobId);
        const s3 = db3.ideaSearches.find((x) => x.id === job.ideaSearchId);
        if (!j3 || !s3) throw new Error("Job/search missing after OpenAI call");

        j3.stage = "done";
        j3.updatedAt = now();

        // Step 3: Write thumbnails to disk and create lightweight idea candidates
        const ideas = images.map((img, idx) => {
          const baseName = `preview_${s3.id}_${idx + 1}`;
          const written = writeGeneratedThumbPng({ baseName, pngBase64: img.pngBase64 });
          return {
            title: count > 1 ? `${title} (${idx + 1})` : title, // e.g., "Space Shuttle (1)", "Space Shuttle (2)" or just "Space Shuttle" if count=1
            preview_thumbnail: written.url,
            previewStatus: "done" as const,
            ldrawStatus: "not_started" as const
          };
        });

        s3.title = title; // Store extracted title on the search itself
        s3.ideas = ideas as any;
        s3.status = "done";
        s3.updatedAt = now();
        s3.error = undefined;

        j3.status = "done";
        j3.stage = "done";
        j3.updatedAt = s3.updatedAt!;
        j3.finishedAt = j3.updatedAt;
        pushLog(j3, { type: "done", message: "Job complete" });

        writeDb(db3);

        // No need to enqueue preview jobs anymore — previews are already generated!
      } catch (e) {
        const dbErr = readDb();
        const jErr = dbErr.ideaGenerationJobs.find((x) => x.id === jobId);
        const sErr = dbErr.ideaSearches.find((x) => x.id === (jErr?.ideaSearchId || ""));
        const msg = e instanceof Error ? e.message : "Idea generation failed";
        const at = now();
        if (jErr) {
          jErr.status = "error";
          jErr.stage = "done";
          jErr.error = msg;
          jErr.updatedAt = at;
          jErr.finishedAt = at;
          pushLog(jErr, { type: "error", message: msg });
        }
        if (sErr) {
          sErr.status = "error";
          sErr.error = msg;
          sErr.updatedAt = at;
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


