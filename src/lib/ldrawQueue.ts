import { readDb, writeDb } from "@/lib/storage";
import { newId } from "@/lib/ids";
import type { LDrawGenerationJob, LDrawJobLogEvent, IdeaCandidate } from "@/lib/models";
import { generateLDrawMpdForIdea, type OpenAIValidateEvent } from "@/lib/openai";
import { validateLDrawMpdOrThrow } from "@/lib/ldrawValidate";
import { generateInstructionsPdfFromMpd, generateThumbnailPngFromMpd, writeIdeaMpdToDisk } from "@/lib/lpub3d";

const inMemoryQueue: string[] = []; // job ids
let workerRunning = false;

function now() {
  return new Date().toISOString();
}

function isValidationToolLoopEnabled() {
  const raw = process.env.OPENAI_USE_VALIDATION_TOOL_LOOP;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function pushLog(job: LDrawGenerationJob, event: Omit<LDrawJobLogEvent, "at">) {
  job.logs.push({ at: now(), ...event });
  if (job.logs.length > 200) job.logs.splice(0, job.logs.length - 200);
}

export function createLDrawJob(params: { ideaSearchId: string; ideaIndex: number }): LDrawGenerationJob {
  const at = now();
  return {
    id: newId("ldrawjob"),
    ideaSearchId: params.ideaSearchId,
    ideaIndex: params.ideaIndex,
    status: "queued",
    stage: "mpd_chunking",
    createdAt: at,
    updatedAt: at,
    logs: [{ at, type: "queued", message: "Job queued" }]
  };
}

export function enqueueLDrawJob(params: { ideaSearchId: string; ideaIndex: number }) {
  const db = readDb();
  const search = db.ideaSearches.find((s) => s.id === params.ideaSearchId);
  if (!search) throw new Error("Idea search not found");
  if (!Array.isArray(search.ideas) || params.ideaIndex < 0 || params.ideaIndex >= search.ideas.length) {
    throw new Error("Invalid idea index");
  }

  const existing = search.ideas[params.ideaIndex];
  if (existing?.ldrawStatus === "running" || existing?.ldrawStatus === "queued") {
    // idempotent-ish: just return existing job if present
    return { job: db.ldrawGenerationJobs.find((j) => j.id === existing.ldrawJobId) || null, alreadyRunning: true };
  }

  const job = createLDrawJob(params);
  db.ldrawGenerationJobs.unshift(job);

  // mark idea as queued
  search.ideas[params.ideaIndex] = {
    ...(existing as any),
    ldrawStatus: "queued",
    ldrawJobId: job.id,
    ldrawError: undefined
  };
  search.updatedAt = now();
  writeDb(db);

  inMemoryQueue.push(job.id);
  void runWorker();
  return { job, alreadyRunning: false };
}

export function getLDrawJob(jobId: string) {
  const db = readDb();
  return db.ldrawGenerationJobs.find((j) => j.id === jobId) || null;
}

function constraintsToText(search: {
  targetPartsMin?: number;
  targetPartsMax?: number;
  difficulty?: "easy" | "medium" | "hard";
  age?: number;
  buildTimeMinutes?: number;
}) {
  const lines = [
    search.targetPartsMin || search.targetPartsMax
      ? `Target parts range: ${search.targetPartsMin ?? "?"}–${search.targetPartsMax ?? "?"}`
      : "Target parts range: (not specified)",
    search.difficulty ? `Difficulty: ${search.difficulty}` : "Difficulty: (not specified)",
    search.age ? `Age: ${search.age}+` : "Age: (not specified)",
    search.buildTimeMinutes ? `Build time target: ${search.buildTimeMinutes} minutes` : "Build time target: (not specified)"
  ];
  return lines.join("\n");
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (inMemoryQueue.length > 0) {
      const jobId = inMemoryQueue.shift();
      if (!jobId) continue;

      const db = readDb();
      const job = db.ldrawGenerationJobs.find((j) => j.id === jobId);
      if (!job) continue;
      if (job.status !== "queued") continue;

      const search = db.ideaSearches.find((s) => s.id === job.ideaSearchId);
      if (!search) {
        job.status = "error";
        job.stage = "done";
        job.error = "Missing idea search for job";
        job.updatedAt = now();
        job.finishedAt = job.updatedAt;
        pushLog(job, { type: "error", message: job.error });
        writeDb(db);
        continue;
      }

      const idea = search.ideas?.[job.ideaIndex] as IdeaCandidate | undefined;
      if (!idea) {
        job.status = "error";
        job.stage = "done";
        job.error = "Missing idea for job";
        job.updatedAt = now();
        job.finishedAt = job.updatedAt;
        pushLog(job, { type: "error", message: job.error });
        writeDb(db);
        continue;
      }

      const startedAt = now();
      job.status = "running";
      job.stage = "mpd_chunking";
      job.startedAt = startedAt;
      job.updatedAt = startedAt;
      pushLog(job, { type: "started", message: "Job started" });

      // update idea status
      idea.ldrawStatus = "running";
      idea.ldrawError = undefined;
      search.updatedAt = startedAt;
      writeDb(db);

      const heartbeat = setInterval(() => {
        try {
          const dbH = readDb();
          const j = dbH.ldrawGenerationJobs.find((x) => x.id === jobId);
          const s = dbH.ideaSearches.find((x) => x.id === (j?.ideaSearchId || ""));
          const i = s?.ideas?.[j?.ideaIndex ?? -1] as IdeaCandidate | undefined;
          if (!j || j.status !== "running") return;
          const at = now();
          j.updatedAt = at;
          pushLog(j, { type: "heartbeat", message: "Generating LDraw..." });
          if (s) s.updatedAt = at;
          if (i && i.ldrawStatus === "running") i.ldrawStatus = "running";
          writeDb(dbH);
        } catch {
          // ignore
        }
      }, 15000);

      try {
        const db2 = readDb();
        const s2 = db2.ideaSearches.find((s) => s.id === job.ideaSearchId);
        const j2 = db2.ldrawGenerationJobs.find((j) => j.id === jobId);
        if (!s2 || !j2) throw new Error("Job/search missing during execution");
        const idea2 = s2.ideas?.[j2.ideaIndex] as IdeaCandidate | undefined;
        if (!idea2) throw new Error("Idea missing during execution");

        const useToolLoop = isValidationToolLoopEnabled();
        j2.maxRounds = useToolLoop ? 2 : 0;
        pushLog(j2, { type: "openai_round_start", message: useToolLoop ? "Calling OpenAI (with validation tool)…" : "Calling OpenAI…" });
        writeDb(db2);

        const { ldraw_mpd, model } = await generateLDrawMpdForIdea({
          inventory: db2.inventory,
          preferences: s2.preferences,
          constraintsText: constraintsToText(s2),
          idea: { title: idea2.title, description: idea2.description, spec: idea2.spec },
          useValidationToolLoop: useToolLoop,
          onEvent: (evt: OpenAIValidateEvent) => {
            const dbE = readDb();
            const j = dbE.ldrawGenerationJobs.find((x) => x.id === jobId);
            const s = dbE.ideaSearches.find((x) => x.id === (j?.ideaSearchId || ""));
            if (!j) return;
            j.updatedAt = now();
            if (evt.type === "tool_calls") {
              pushLog(j, { type: "openai_tool_calls", message: `OpenAI requested ${evt.calls.length} validation call(s)`, data: evt.calls });
            } else if (evt.type === "tool_results") {
              pushLog(j, { type: "openai_tool_results", message: "Validation tool results received", data: evt.results });
            } else if (evt.type === "round_start") {
              pushLog(j, { type: "openai_round_start", message: `OpenAI round ${evt.round} start` });
            } else if (evt.type === "round_done") {
              pushLog(j, { type: "openai_round_done", message: `OpenAI round ${evt.round} complete` });
            } else if (evt.type === "api_retry") {
              pushLog(j, { type: "openai_round_done", message: `OpenAI retry (round ${evt.round}, attempt ${evt.attempt}): ${evt.message}` });
            } else if (evt.type === "api_response") {
              pushLog(j, { type: "openai_round_done", message: `OpenAI response (round ${evt.round}): status=${evt.status ?? "?"} model=${evt.model ?? "?"}`, data: evt });
            }
            if (s) s.updatedAt = j.updatedAt;
            writeDb(dbE);
          }
        });

        const db3 = readDb();
        const s3 = db3.ideaSearches.find((s) => s.id === job.ideaSearchId);
        const j3 = db3.ldrawGenerationJobs.find((j) => j.id === jobId);
        if (!s3 || !j3) throw new Error("Job/search missing after OpenAI call");
        const idea3 = s3.ideas?.[j3.ideaIndex] as IdeaCandidate | undefined;
        if (!idea3) throw new Error("Idea missing after OpenAI call");

        pushLog(j3, { type: "openai_round_done", message: "OpenAI returned MPD" });
        j3.stage = "thumbnail";
        j3.updatedAt = now();
        pushLog(j3, { type: "lpub3d_start", message: "Generating thumbnail via LPub3D…" });

        // Validate before rendering.
        validateLDrawMpdOrThrow({ ldrawMpd: ldraw_mpd });
        const baseName = `idea_${s3.id}_${j3.ideaIndex + 1}`;
        const mpdPath = writeIdeaMpdToDisk({ baseName, ldrawMpd: ldraw_mpd });
        const thumb = generateThumbnailPngFromMpd({ mpdPath, baseName, size: 1024 });
        j3.stage = "pdf";
        j3.updatedAt = now();
        pushLog(j3, { type: "lpub3d_start", message: "Generating PDF via LPub3D…" });
        const pdf = generateInstructionsPdfFromMpd({ mpdPath, baseName });

        idea3.ldraw_mpd = ldraw_mpd;
        idea3.thumbnail = thumb.url;
        idea3.instructions_pdf = pdf.url;
        idea3.ldrawStatus = "done";
        idea3.ldrawError = undefined;

        // store model used for MPD generation too (best-effort; keep existing ideation model if present)
        s3.model = s3.model || model;
        s3.updatedAt = now();

        j3.status = "done";
        j3.stage = "done";
        j3.updatedAt = s3.updatedAt!;
        j3.finishedAt = j3.updatedAt;
        pushLog(j3, { type: "lpub3d_done", message: "LPub3D assets generated" });
        pushLog(j3, { type: "done", message: "Job complete" });
        writeDb(db3);
      } catch (e) {
        const dbErr = readDb();
        const jErr = dbErr.ldrawGenerationJobs.find((x) => x.id === jobId);
        const sErr = dbErr.ideaSearches.find((x) => x.id === (jErr?.ideaSearchId || ""));
        const iErr = sErr?.ideas?.[jErr?.ideaIndex ?? -1] as IdeaCandidate | undefined;
        const msg = e instanceof Error ? e.message : "LDraw generation failed";
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
          sErr.updatedAt = at;
        }
        if (iErr) {
          iErr.ldrawStatus = "error";
          iErr.ldrawError = msg;
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


