import { readDb, writeDb } from "@/lib/storage";
import { newId } from "@/lib/ids";
import type { LDrawGenerationJob, LDrawJobLogEvent, IdeaCandidate } from "@/lib/models";
import fs from "node:fs";
import path from "node:path";
import {
  generateBlueprintForIdea,
  generateLDrawMpdChunkForIdea,
  type OpenAIValidateEvent
} from "@/lib/openai";
import { validateLDrawMpdOrThrow, validateLDrawPartialMpdOrThrow } from "@/lib/ldrawValidate";
import { generateInstructionsPdfFromMpd, generateThumbnailPngFromMpd, writeIdeaMpdToDisk } from "@/lib/lpub3d";
import { writeGeneratedThumbPng } from "@/lib/generatedAssets";
import { TokenTracker, calculateCost, formatUsageEntry } from "@/lib/tokenUsage";
import { config } from "dotenv";

// Load .env.local explicitly (Next.js API routes auto-load it, but background workers don't)
config({ path: path.join(process.cwd(), ".env.local") });

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

function isJobCancelled(jobId: string) {
  const db = readDb();
  const j = db.ldrawGenerationJobs.find((x) => x.id === jobId);
  return j?.status === "cancelled" || Boolean(j?.cancelRequestedAt);
}

function markCancelled(jobId: string, message = "Cancelled by user") {
  const db = readDb();
  const j = db.ldrawGenerationJobs.find((x) => x.id === jobId);
  const s = db.ideaSearches.find((x) => x.id === (j?.ideaSearchId || ""));
  const i = s?.ideas?.[j?.ideaIndex ?? -1] as IdeaCandidate | undefined;
  if (!j) return;
  const at = now();
  j.status = "cancelled";
  j.stage = "done";
  j.error = message;
  j.updatedAt = at;
  j.cancelledAt = at;
  j.finishedAt = at;
  pushLog(j, { type: "error", message });
  if (i) {
    i.ldrawStatus = "cancelled";
    i.ldrawError = message;
  }
  if (s) s.updatedAt = at;
  writeDb(db);
}

export function createLDrawJob(params: { ideaSearchId: string; ideaIndex: number }): LDrawGenerationJob {
  const at = now();
  return {
    id: newId("ldrawjob"),
    ideaSearchId: params.ideaSearchId,
    ideaIndex: params.ideaIndex,
    status: "queued",
    stage: "preview",
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

function parseBlueprintStepsPerBatch(): number {
  const raw = process.env.BLUEPRINT_STEPS_PER_MPD_BATCH;
  if (!raw) return 6;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 6;
  return Math.max(1, Math.min(25, Math.floor(n)));
}

function wrapMpd(body: string) {
  const b = String(body || "").trim();
  return ["0 FILE model.ldr", b, "0 NOFILE"].filter((x) => x.trim().length > 0).join("\n") + "\n";
}

function filterInventoryBasicParts(inventory: Array<{ partNum?: string }>) {
  // Core/basic parts only (bricks/plates/tiles/slopes) — no specialty parts.
  // We match the numeric prefix of partNum so variants like "3069b" still count as "3069".
  const allowed = new Set([
    // Bricks
    "3005", // 1x1 brick
    "3004", // 1x2 brick
    "3003", // 2x2 brick
    "3002", // 2x3 brick
    "3001", // 2x4 brick
    "3010", // 1x4 brick
    "3009", // 1x6 brick
    // Plates
    "3024", // 1x1 plate
    "3023", // 1x2 plate
    "3022", // 2x2 plate
    "3021", // 2x3 plate
    "3020", // 2x4 plate
    // Tiles
    "3062", // 1x1 tile
    "3069", // 1x2 tile
    "3068", // 2x2 tile
    // Common slopes (still "basic" shape)
    "3039", // slope 45 2x2
    "3040", // slope 45 2x1
    "3037", // slope 45 2x4
    "3038" // slope 45 2x3
  ]);

  const out: any[] = [];
  for (const it of inventory || []) {
    const raw = String((it as any)?.partNum || "");
    const m = raw.match(/^(\d+)/);
    const base = m?.[1] || "";
    if (!base) continue;
    if (!allowed.has(base)) continue;
    out.push(it);
  }
  return out;
}

function bucketColorName(colorName: string) {
  const c = String(colorName || "").trim().toLowerCase();
  if (!c) return "Unknown";
  if (c.startsWith("trans")) return "Trans";
  if (/(silver|chrome|metallic|flat silver|pearl|pearlescent)/i.test(c)) return "Metallic";
  if (/gold/i.test(c)) return "Gold";

  if (/black/i.test(c)) return "Black";
  if (/white/i.test(c)) return "White";
  if (/gray|grey|bluish gray|stone/i.test(c)) return "Gray";
  if (/brown|tan|nougat|beige|sand/i.test(c)) return "BrownTan";
  if (/red|dark red|magenta|pink/i.test(c)) return "RedPink";
  if (/orange|coral/i.test(c)) return "Orange";
  if (/yellow/i.test(c)) return "Yellow";
  if (/green|lime/i.test(c)) return "Green";
  if (/blue|azure|teal/i.test(c)) return "Blue";
  if (/purple|violet|lavender/i.test(c)) return "Purple";
  return "Other";
}

function maybeBucketInventoryColors(inventory: any[]) {
  return (inventory || []).map((it) => ({ ...it, colorName: bucketColorName(String(it?.colorName || "")) }));
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

      if (isJobCancelled(jobId)) {
        markCancelled(jobId);
        continue;
      }

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
      job.stage = "preview";
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
          if (!j) return;
          if (j.status === "cancelled" || j.cancelRequestedAt) return;
          if (j.status !== "running") return;
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
        let lastPartialRenderAtMs = 0;
        if (isJobCancelled(jobId)) throw new Error("__CANCELLED__");
        const db2 = readDb();
        const s2 = db2.ideaSearches.find((s) => s.id === job.ideaSearchId);
        const j2 = db2.ldrawGenerationJobs.find((j) => j.id === jobId);
        if (!s2 || !j2) throw new Error("Job/search missing during execution");
        const idea2 = s2.ideas?.[j2.ideaIndex] as IdeaCandidate | undefined;
        if (!idea2) throw new Error("Idea missing during execution");
        if (j2.status === "cancelled" || j2.cancelRequestedAt) throw new Error("__CANCELLED__");

        // Reference image - user uploads their own image showing what they want to build.
        // This is the key visual input for blueprint generation.
        j2.stage = "preview";
        j2.updatedAt = now();
        let referenceImagePath: string | undefined;

        // Check for user-uploaded reference image first
        const referenceUrl = typeof (idea2 as any).reference_image === "string" ? (idea2 as any).reference_image : "";
        if (referenceUrl.startsWith("/")) {
          const candidatePath = path.join(process.cwd(), "public", referenceUrl);
          if (fs.existsSync(candidatePath)) {
            referenceImagePath = candidatePath;
            pushLog(j2, { type: "openai_round_done", message: "Using uploaded reference image" });
          }
        }
        
        // Fall back to legacy preview_thumbnail for backward compatibility
        if (!referenceImagePath) {
          const existingThumbUrl = typeof idea2.preview_thumbnail === "string" ? idea2.preview_thumbnail : "";
          if (existingThumbUrl.startsWith("/")) {
            const candidatePath = path.join(process.cwd(), "public", existingThumbUrl);
            if (fs.existsSync(candidatePath)) {
              referenceImagePath = candidatePath;
              pushLog(j2, { type: "openai_round_done", message: "Using existing thumbnail as reference (legacy)" });
            }
          }
        }

        if (!referenceImagePath) {
          throw new Error("Reference image not found. Please upload a reference image showing what you want to build.");
        }
        s2.updatedAt = now();
        writeDb(db2);
        if (isJobCancelled(jobId)) throw new Error("__CANCELLED__");

        // Blueprint / plan stage (uses reference image as vision input)
        j2.stage = "plan";
        j2.updatedAt = now();
        pushLog(j2, { type: "openai_round_start", message: "Generating blueprint plan from reference image..." });
        writeDb(db2);

        // Token usage tracker for this job - tracks all API calls (blueprint + chunks)
        const tokenTracker = new TokenTracker();
        let currentChunkIdx = 0;

        const blueprintStartedAtMs = Date.now();
        const invForStep2Raw = s2.inventoryMode === "full" ? db2.inventory : filterInventoryBasicParts(db2.inventory);
        const invForStep2 =
          s2.inventoryMode === "basic" && s2.colorMode === "bucketed" ? maybeBucketInventoryColors(invForStep2Raw) : invForStep2Raw;

        const { blueprint, model: blueprintModel, usage: blueprintUsage } = await generateBlueprintForIdea({
          title: idea2.title,
          userPrompt: s2.preferences || "A fun LEGO build",
          inventory: invForStep2,
          constraintsText: constraintsToText(s2),
          referenceImagePath
        });
        const blueprintDurationMs = Date.now() - blueprintStartedAtMs;
        
        // Track blueprint generation token usage
        if (blueprintUsage && blueprintModel) {
          const entry = tokenTracker.record({
            operation: "blueprint",
            model: blueprintModel,
            usage: blueprintUsage,
            duration_ms: blueprintDurationMs
          });
          pushLog(j2, {
            type: "openai_round_done",
            message: `Blueprint generated (model=${blueprintModel}, ${Math.round(blueprintDurationMs / 1000)}s, ${blueprintUsage.total_tokens.toLocaleString()} tokens, $${entry.cost_usd.toFixed(4)})`,
            data: { usage: blueprintUsage, cost_usd: entry.cost_usd }
          });
        } else {
          pushLog(j2, {
            type: "openai_round_done",
            message: `Blueprint generated (model=${blueprintModel}, ${Math.round(blueprintDurationMs / 1000)}s)`
          });
        }

        idea2.ldrawArtifacts = {
          ...(idea2.ldrawArtifacts || {}),
          structure_plan: blueprint,
          step_outline: blueprint.step_outline
        };
        s2.updatedAt = now();
        writeDb(db2);
        if (isJobCancelled(jobId)) throw new Error("__CANCELLED__");

        const useToolLoop = isValidationToolLoopEnabled();
        j2.maxRounds = useToolLoop ? 2 : 0;
        j2.stage = "mpd";
        const stepOutline = (blueprint as any)?.step_outline;
        const stepCount = Array.isArray(stepOutline) ? stepOutline.length : 0;
        const stepsPerBatch = parseBlueprintStepsPerBatch();
        const doChunking = stepCount > 0;
        const totalChunks = doChunking ? Math.ceil(stepCount / stepsPerBatch) : 1;
        j2.progress = { current: 0, total: totalChunks, label: doChunking ? "MPD chunks" : "MPD generation" };
        pushLog(j2, {
          type: "openai_round_start",
          message: doChunking
            ? `Generating MPD in ${totalChunks} chunk(s) (${stepsPerBatch} blueprint step(s) per chunk)…`
            : useToolLoop
              ? "Calling OpenAI (with validation tool)…"
              : "Calling OpenAI…"
        });
        writeDb(db2);

        const onEvent = (evt: OpenAIValidateEvent) => {
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
            // Track token usage
            if (evt.usage && evt.model) {
              const entry = tokenTracker.record({
                operation: `chunk_${currentChunkIdx + 1}_round_${evt.round}`,
                model: evt.model,
                usage: {
                  input_tokens: evt.usage.input_tokens || 0,
                  output_tokens: evt.usage.output_tokens || 0,
                  reasoning_tokens: evt.usage.reasoning_tokens,
                  total_tokens: evt.usage.total_tokens || 0
                }
              });
              const costStr = `$${entry.cost_usd.toFixed(4)}`;
              const tokensStr = `${(entry.usage.input_tokens + entry.usage.output_tokens).toLocaleString()} tokens`;
              pushLog(j, { 
                type: "openai_round_done", 
                message: `OpenAI response (round ${evt.round}): ${tokensStr}, cost: ${costStr}`,
                data: { ...evt, cost_usd: entry.cost_usd }
              });
            } else {
              pushLog(j, { type: "openai_round_done", message: `OpenAI response (round ${evt.round}): status=${evt.status ?? "?"} model=${evt.model ?? "?"}`, data: evt });
            }
          }
          if (s) s.updatedAt = j.updatedAt;
          writeDb(dbE);
        };

        let ldraw_mpd = "";
        let model = "";
        if (!doChunking) {
          throw new Error("Blueprint has no steps. Cannot generate MPD without a step outline.");
        }

        // MPD chunking: generate the MPD in batches based on blueprint steps.
        const chunksMeta: Array<{ index: number; stepsFrom: number; stepsTo: number; charLen?: number }> = [];
        let assembledBody = "";
        for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
            if (isJobCancelled(jobId)) throw new Error("__CANCELLED__");
            currentChunkIdx = chunkIdx; // Track for token usage logging
            const stepsFrom = chunkIdx * stepsPerBatch + 1;
            const stepsTo = Math.min(stepCount, (chunkIdx + 1) * stepsPerBatch);
            const assembledMpdSoFar = assembledBody ? wrapMpd(assembledBody) : "";
            j2.progress = { current: chunkIdx + 1, total: totalChunks, label: "MPD chunks" };
            j2.updatedAt = now();
            pushLog(j2, { type: "openai_round_start", message: `Generating MPD chunk ${chunkIdx + 1}/${totalChunks} (steps ${stepsFrom}–${stepsTo})…` });
            writeDb(db2);

            // Get minimum similarity threshold from env (default 60%)
            const minSimilarity = process.env.MIN_SIMILARITY_SCORE 
              ? parseInt(process.env.MIN_SIMILARITY_SCORE, 10) 
              : 60;

            // Determine which subassembly this chunk belongs to (based on step titles)
            let currentSubassembly: string | undefined;
            const stepOutline = (blueprint as any)?.step_outline || [];
            const subassemblies = (blueprint as any)?.structure_plan?.subassemblies || [];
            
            // Find which subassembly the current steps belong to
            for (let s = stepsFrom; s <= stepsTo; s++) {
              const stepInfo = stepOutline.find((st: any) => st.step === s);
              if (stepInfo?.title) {
                const titleLower = stepInfo.title.toLowerCase();
                for (const sub of subassemblies) {
                  if (titleLower.includes(sub.name.toLowerCase())) {
                    currentSubassembly = sub.name;
                    break;
                  }
                }
              }
              if (currentSubassembly) break;
            }
            
            // Detect subassembly boundary: does this chunk complete a subassembly?
            // A subassembly is complete when the NEXT step belongs to a different subassembly
            let isSubassemblyBoundary = false;
            if (currentSubassembly && stepsTo < stepCount) {
              // Look at the next step after this chunk
              const nextStepInfo = stepOutline.find((st: any) => st.step === stepsTo + 1);
              if (nextStepInfo?.title) {
                const nextTitleLower = nextStepInfo.title.toLowerCase();
                // Check if next step belongs to a DIFFERENT subassembly
                let nextSubassembly: string | undefined;
                for (const sub of subassemblies) {
                  if (nextTitleLower.includes(sub.name.toLowerCase())) {
                    nextSubassembly = sub.name;
                    break;
                  }
                }
                // Boundary if next step is different subassembly (or no subassembly)
                if (nextSubassembly !== currentSubassembly) {
                  isSubassemblyBoundary = true;
                  pushLog(j2, { 
                    type: "openai_round_start", 
                    message: `Subassembly "${currentSubassembly}" complete - triggering visual feedback` 
                  });
                  writeDb(db2);
                }
              }
            }
            
            const isFinalChunk = chunkIdx === totalChunks - 1;

            const { chunkBody, model: chunkModel } = await generateLDrawMpdChunkForIdea({
              title: idea2.title,
              userPrompt: s2.preferences || "A fun LEGO build",
              inventory: invForStep2,
              constraintsText: constraintsToText(s2),
              blueprint,
              stepFrom: stepsFrom,
              stepTo: stepsTo,
              assembledMpdSoFar,
              useValidationToolLoop: useToolLoop,
              onEvent,
              // Pass reference image for render-based validation (similarity checking)
              referenceImagePath,
              minSimilarity,
              // Pass current subassembly for targeted validation
              currentSubassembly,
              // Visual feedback triggers: at subassembly boundaries and final chunk
              isSubassemblyBoundary,
              isFinalChunk
            });
            model = model || chunkModel;

            assembledBody = [assembledBody, chunkBody].filter(Boolean).join("\n").trim() + "\n";
            // Validate "all steps up through this one" (assembled MPD so far)
            const partialMpd = wrapMpd(assembledBody);
            validateLDrawPartialMpdOrThrow(partialMpd);

            // Persist partial MPD + (best-effort) throttled partial render for UI.
            idea2.ldrawArtifacts = {
              ...(idea2.ldrawArtifacts || {}),
              partial_mpd: partialMpd,
              partial_updated_at: now()
            };
            s2.updatedAt = now();
            writeDb(db2);

            const nowMs = Date.now();
            const shouldRender = nowMs - lastPartialRenderAtMs >= 15_000;
            if (shouldRender) {
              try {
                const baseName = `partial_${s2.id}_${j2.ideaIndex + 1}`;
                const mpdPath = writeIdeaMpdToDisk({ baseName, ldrawMpd: partialMpd });
                const thumb = generateThumbnailPngFromMpd({ mpdPath, baseName, size: 768 });
                idea2.ldrawArtifacts = {
                  ...(idea2.ldrawArtifacts || {}),
                  partial_thumbnail: thumb.url,
                  partial_updated_at: now(),
                  partial_mpd: partialMpd
                };
                s2.updatedAt = now();
                j2.updatedAt = s2.updatedAt!;
                pushLog(j2, { type: "lpub3d_done", message: `Partial render updated (${chunkIdx + 1}/${totalChunks})` });
                writeDb(db2);
                lastPartialRenderAtMs = nowMs;
              } catch (eRender) {
                // Best-effort only: do NOT fail the job if a partial render fails.
                pushLog(j2, {
                  type: "error",
                  message: `Partial render failed (non-fatal): ${eRender instanceof Error ? eRender.message : "unknown error"}`
                });
                writeDb(db2);
              }
            }

            chunksMeta.push({ index: chunkIdx, stepsFrom, stepsTo, charLen: chunkBody.length });
            j2.updatedAt = now();
            pushLog(j2, { type: "openai_round_done", message: `Chunk ${chunkIdx + 1}/${totalChunks} done` });
            writeDb(db2);
          }

        ldraw_mpd = wrapMpd(assembledBody);
        // Final, full validation happens below (before rendering).
        idea2.ldrawArtifacts = {
          ...(idea2.ldrawArtifacts || {}),
          chunks: chunksMeta
        };
        s2.updatedAt = now();
        writeDb(db2);

        if (isJobCancelled(jobId)) throw new Error("__CANCELLED__");

        const db3 = readDb();
        const s3 = db3.ideaSearches.find((s) => s.id === job.ideaSearchId);
        const j3 = db3.ldrawGenerationJobs.find((j) => j.id === jobId);
        if (!s3 || !j3) throw new Error("Job/search missing after OpenAI call");
        const idea3 = s3.ideas?.[j3.ideaIndex] as IdeaCandidate | undefined;
        if (!idea3) throw new Error("Idea missing after OpenAI call");
        if (j3.status === "cancelled" || j3.cancelRequestedAt) throw new Error("__CANCELLED__");

        pushLog(j3, { type: "openai_round_done", message: "OpenAI returned MPD" });
        j3.stage = "final_thumbnail";
        j3.updatedAt = now();
        pushLog(j3, { type: "lpub3d_start", message: "Generating thumbnail via LPub3D…" });

        // Validate before rendering.
        validateLDrawMpdOrThrow(ldraw_mpd);
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
        
        // Log token usage summary
        const usageSummary = tokenTracker.getSummary();
        if (usageSummary.total_tokens > 0) {
          pushLog(j3, { 
            type: "token_usage", 
            message: `Token usage: ${usageSummary.total_tokens.toLocaleString()} tokens ($${usageSummary.total_cost_usd.toFixed(4)})`,
            data: {
              total_input_tokens: usageSummary.total_input_tokens,
              total_output_tokens: usageSummary.total_output_tokens,
              total_reasoning_tokens: usageSummary.total_reasoning_tokens,
              total_tokens: usageSummary.total_tokens,
              total_cost_usd: usageSummary.total_cost_usd,
              by_operation: usageSummary.by_operation
            }
          });
          // Also log to console for visibility
          // eslint-disable-next-line no-console
          console.log(`[ldrawQueue] Job ${jobId} complete. ${usageSummary.total_tokens.toLocaleString()} tokens, cost: $${usageSummary.total_cost_usd.toFixed(4)}`);
        }
        
        pushLog(j3, { type: "done", message: "Job complete" });
        writeDb(db3);
      } catch (e) {
        if (e instanceof Error && e.message === "__CANCELLED__") {
          markCancelled(jobId);
          continue;
        }
        const dbErr = readDb();
        const jErr = dbErr.ldrawGenerationJobs.find((x) => x.id === jobId);
        const sErr = dbErr.ideaSearches.find((x) => x.id === (jErr?.ideaSearchId || ""));
        const iErr = sErr?.ideas?.[jErr?.ideaIndex ?? -1] as IdeaCandidate | undefined;
        const msg = e instanceof Error ? e.message : "LDraw generation failed";
        const at = now();
        if (jErr) {
          if (jErr.status !== "cancelled" && !jErr.cancelRequestedAt) {
            jErr.status = "error";
            jErr.stage = "done";
            jErr.error = msg;
            jErr.updatedAt = at;
            jErr.finishedAt = at;
            pushLog(jErr, { type: "error", message: msg });
          }
        }
        if (sErr) {
          sErr.updatedAt = at;
        }
        if (iErr) {
          if (iErr.ldrawStatus !== "cancelled") {
            iErr.ldrawStatus = "error";
            iErr.ldrawError = msg;
          }
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


