import { readDb, writeDb } from "@/lib/storage";
import { newId } from "@/lib/ids";
import type { IdeaGenerationJob, IdeaJobLogEvent } from "@/lib/models";
import { generateBuildIdeasStructured, type OpenAIValidateEvent } from "@/lib/openai";
import { enqueuePreviewJob } from "@/lib/previewQueue";

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
        // Re-read latest inventory + params from search (so we persist exact user inputs).
        const db2 = readDb();
        const s2 = db2.ideaSearches.find((s) => s.id === job.ideaSearchId);
        if (!s2) throw new Error("Idea search missing during execution");

        pushLog(job, {
          type: "openai_round_start",
          message: "Calling OpenAI to generate ideas…"
        });
        writeDb(db2);

        const { ideas, model } = await generateBuildIdeasStructured({
          inventory: db2.inventory,
          preferences: s2.preferences,
          targetPartsMin: s2.targetPartsMin,
          targetPartsMax: s2.targetPartsMax,
          difficulty: s2.difficulty,
          age: s2.age,
          buildTimeMinutes: s2.buildTimeMinutes,
          count: s2.count ?? 2,
          // logging callbacks
          onEvent: (evt: OpenAIValidateEvent) => {
            const dbE = readDb();
            const j = dbE.ideaGenerationJobs.find((x) => x.id === jobId);
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
              const u = evt.usage;
              const usageStr = u
                ? `input=${u.input_tokens ?? "?"} output=${u.output_tokens ?? "?"} reasoning=${u.reasoning_tokens ?? "?"} total=${u.total_tokens ?? "?"}`
                : "usage=?";
              pushLog(j, {
                type: "openai_round_done",
                message: `OpenAI response (round ${evt.round}): status=${evt.status ?? "?"} model=${evt.model ?? "?"} ${usageStr}`,
                data: evt
              });
            }
            if (s) s.updatedAt = j.updatedAt;
            writeDb(dbE);
          }
        } as any);

        const db3 = readDb();
        const j3 = db3.ideaGenerationJobs.find((x) => x.id === jobId);
        const s3 = db3.ideaSearches.find((x) => x.id === job.ideaSearchId);
        if (!j3 || !s3) throw new Error("Job/search missing after OpenAI call");

        pushLog(j3, { type: "openai_round_done", message: "OpenAI returned candidate ideas" });
        j3.stage = "done";
        j3.updatedAt = now();

        s3.model = model;
        s3.ideas = ideas.map((i) => ({ ...i, previewStatus: "not_started", ldrawStatus: "not_started" })) as any;
        s3.status = "done";
        s3.updatedAt = now();
        s3.error = undefined;

        j3.status = "done";
        j3.stage = "done";
        j3.updatedAt = s3.updatedAt!;
        j3.finishedAt = j3.updatedAt;
        pushLog(j3, { type: "done", message: "Job complete" });

        writeDb(db3);

        // Kick off preview thumbnails (micro MPD) in the background so the UI can show something quickly.
        for (let idx = 0; idx < (s3.ideas?.length || 0); idx++) {
          try {
            enqueuePreviewJob({ ideaSearchId: s3.id, ideaIndex: idx });
          } catch {
            // ignore preview enqueue errors
          }
        }
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


