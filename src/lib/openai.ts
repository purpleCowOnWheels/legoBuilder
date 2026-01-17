import { InventoryItem, type IdeaCandidate as IdeaCandidateModel } from "@/lib/models";
import { validateLDrawMpdOrThrow } from "@/lib/ldrawValidate";
import { validateLDrawMpdChunkBodyOrThrow, validateLDrawPartialMpdOrThrow } from "@/lib/ldrawValidate";
import { validateRenderForToolLoop, type RenderValidationInput, type BlueprintInfo, type ToolLoopValidationResult } from "@/lib/renderValidation";
import fs from "node:fs";
import path from "node:path";

/**
 * Visual feedback mode controls when rendered images are sent back to GPT for visual review.
 * 
 * - "subassemblies": Send images at subassembly completion boundaries (default, recommended)
 * - "final_only": Only send image after final validation
 * - "none": Never send images (text-based physics validation only)
 */
export type VisualFeedbackMode = "subassemblies" | "final_only" | "none";

type OpenAIResponse = {
  id?: string;
  status?: string;
  incomplete_details?: { reason?: string };
  output_text?: string;
  output?: Array<{
    type: string;
    content?: Array<{ type: string; text?: string }>;
    // tool calling (best-effort typing; varies by model/version)
    id?: string;
    call_id?: string;
    tool_call_id?: string;
    name?: string;
    arguments?: string;
    function?: { name?: string; arguments?: string };
  }>;
};

type OpenAIImageResponse = {
  created?: number;
  data?: Array<{ b64_json?: string; revised_prompt?: string; url?: string }>;
};

type ToolCall = { id: string; name: string; arguments: unknown };
export type OpenAIValidateEvent =
  | { type: "round_start"; round: number }
  | {
      type: "api_response";
      round: number;
      response_id?: string;
      status?: string;
      model?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        reasoning_tokens?: number;
        total_tokens?: number;
      };
    }
  | { type: "api_retry"; round: number; attempt: number; message: string }
  | {
      type: "tool_calls";
      round: number;
      calls: Array<{
        id: string;
        name: string;
        expected_parts?: number;
        ldraw_len?: number;
        ldraw_first_line?: string;
        ldraw_last_line?: string;
      }>;
    }
  | { 
      type: "tool_results"; 
      round: number; 
      results: Array<{ 
        tool_call_id: string; 
        ok: boolean; 
        error?: string;
        similarity_score?: number;
        issues?: Array<{ type: string; message: string }>;
      }>;
    }
  | { type: "round_done"; round: number }
  | { 
      type: "visual_feedback_sent"; 
      round: number; 
      image_count: number;
      /** Describes when visual feedback was triggered */
      trigger: "subassembly_boundary" | "final_validation";
    };

async function fetchResponsesJsonWithRetry(params: {
  apiKey: string;
  body: Record<string, unknown>;
  roundForLogging: number;
  onRetry?: (evt: { attempt: number; message: string }) => void;
}) {
  const maxAttempts = 3; // initial + 2 retries
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Hard timeout so a single OpenAI request can't hang indefinitely.
      // Keep this conservative; MPD generation can be slow.
      const timeoutMs = 120_000;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(params.body),
        signal: controller.signal
      });
      clearTimeout(timeout);

      const rawText = await res.text();
      if (!res.ok) {
        // Retry transient OpenAI/server issues.
        if (res.status >= 500 && attempt < maxAttempts) {
          params.onRetry?.({ attempt, message: `OpenAI ${res.status} (server error). Retrying…` });
          const delayMs = attempt === 1 ? 1000 : 3000;
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        throw new Error(`OpenAI error ${res.status}: ${rawText}`);
      }

      return JSON.parse(rawText) as OpenAIResponse;
    } catch (e) {
      const isAbort = e instanceof Error && (e.name === "AbortError" || /aborted/i.test(e.message));
      if (isAbort && attempt < maxAttempts) {
        params.onRetry?.({ attempt, message: "OpenAI request timed out. Retrying…" });
        const delayMs = attempt === 1 ? 1000 : 3000;
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      if (attempt < maxAttempts) {
        params.onRetry?.({
          attempt,
          message: `OpenAI request failed (${e instanceof Error ? e.message : "unknown error"}). Retrying…`
        });
        const delayMs = attempt === 1 ? 1000 : 3000;
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw e;
    }
  }
  throw new Error(`OpenAI request failed after retries (round ${params.roundForLogging})`);
}

async function fetchImagesJsonWithRetry(params: { apiKey: string; body: Record<string, unknown> }) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const timeoutMs = 120_000;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(params.body),
        signal: controller.signal
      });
      clearTimeout(timeout);

      const rawText = await res.text();
      if (!res.ok) {
        if (res.status >= 500 && attempt < maxAttempts) {
          const delayMs = attempt === 1 ? 1000 : 3000;
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        throw new Error(`OpenAI image error ${res.status}: ${rawText}`);
      }
      return JSON.parse(rawText) as OpenAIImageResponse;
    } catch (e) {
      const isAbort = e instanceof Error && (e.name === "AbortError" || /aborted/i.test(e.message));
      if ((isAbort || e instanceof Error) && attempt < maxAttempts) {
        const delayMs = attempt === 1 ? 1000 : 3000;
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw e;
    }
  }
  throw new Error("OpenAI image request failed after retries");
}

function normalizeColorKey(colorName: string) {
  // Example: "Light Bluish Gray" -> "LightBluishGray", "Trans-Clear" -> "TransClear"
  const cleaned = String(colorName || "Unknown")
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "");
  return cleaned.length > 0 ? cleaned : "Unknown";
}

function inventoryToCompactJson(inventory: InventoryItem[]) {
  // Token-compact + deterministic representation:
  // {
  //   "3001": {"LightBluishGray": 4, "DarkBluishGray": 3, "Red": 2},
  //   "3004": {"LightBluishGray": 9, "ReddishBrown": 1, "Black": 4}
  // }
  const out: Record<string, Record<string, number>> = {};

  for (const i of inventory) {
    const partNum = String(i?.partNum || "").trim();
    if (!partNum) continue;
    const qty = typeof i.quantity === "number" && Number.isFinite(i.quantity) ? Math.floor(i.quantity) : 0;
    if (qty <= 0) continue;
    const colorKey = normalizeColorKey(i.colorName || "Unknown");
    out[partNum] ||= {};
    out[partNum][colorKey] = (out[partNum][colorKey] || 0) + qty;
  }

  // Deterministic key ordering (stable JSON string)
  const sortedPartNums = Object.keys(out).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const stable: Record<string, Record<string, number>> = {};
  for (const partNum of sortedPartNums) {
    const colors = out[partNum] || {};
    const sortedColors = Object.keys(colors).sort((a, b) => {
      const da = colors[a] || 0;
      const db = colors[b] || 0;
      return db - da || a.localeCompare(b);
    });
    const stableColors: Record<string, number> = {};
    for (const c of sortedColors) stableColors[c] = colors[c];
    stable[partNum] = stableColors;
  }

  return JSON.stringify(stable);
}

function isDebugEnabled() {
  return process.env.DEBUG_OPENAI === "1" || process.env.DEBUG_OPENAI?.toLowerCase() === "true";
}

function writeOpenAIDebugArtifact(params: {
  tag: string;
  prompt: string;
  rawResponseJson: unknown;
  extractedText: string;
  note?: string;
}) {
  if (!isDebugEnabled()) return null as string | null;

  const dir = path.join(process.cwd(), "data", "openai-debug");
  fs.mkdirSync(dir, { recursive: true });
  const id = `${params.tag}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const filePath = path.join(dir, `${id}.json`);

  const payload = {
    id,
    tag: params.tag,
    at: new Date().toISOString(),
    note: params.note,
    prompt: params.prompt,
    extractedText: params.extractedText,
    rawResponseJson: params.rawResponseJson
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  // Also write a short pointer to server logs so it's easy to find.
  // eslint-disable-next-line no-console
  console.error(`[openai-debug] wrote ${filePath}`);
  return id;
}

function parseJsonObjectFromText(text: string) {
  const trimmed = text.trim();
  const noFences = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  // Try direct parse first
  try {
    return JSON.parse(noFences) as unknown;
  } catch {
    // Fallback: extract the outermost JSON object
    const start = noFences.indexOf("{");
    const end = noFences.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error(`OpenAI returned non-JSON output. Raw:\n${noFences.slice(0, 2000)}`);
    }
    const maybe = noFences.slice(start, end + 1);
    return JSON.parse(maybe) as unknown;
  }
}

function extractTextFromResponses(json: OpenAIResponse) {
  return (
    (typeof json.output_text === "string" && json.output_text.trim().length > 0
      ? json.output_text
      : json.output
          ?.flatMap((o) => o.content ?? [])
          .filter((c) => typeof c.text === "string" && c.text.trim().length > 0)
          .map((c) => c.text)
          .join("\n\n")) || ""
  );
}

function extractToolCallsFromResponses(json: OpenAIResponse): ToolCall[] {
  const out = Array.isArray(json.output) ? json.output : [];
  const calls: ToolCall[] = [];

  for (const o of out) {
    // Common shapes:
    // - { type: "function_call", call_id, name, arguments }
    // - { type: "tool_call", id, name, arguments }
    // - { type: "function_call", id, function: { name, arguments } }
    const t = String(o.type || "");
    const isCall = t === "function_call" || t === "tool_call";
    if (!isCall) continue;

    const id = String(o.call_id || o.tool_call_id || o.id || "").trim();
    const name = String(o.name || o.function?.name || "").trim();
    const args = (o.arguments ?? o.function?.arguments) as unknown;
    if (!id || !name) continue;
    calls.push({ id, name, arguments: args ?? {} });
  }

  return calls;
}

function parseToolArgs(raw: unknown) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return {};
    try {
      return JSON.parse(s) as Record<string, unknown>;
    } catch {
      return { _raw: s };
    }
  }
  return { _raw: String(raw) };
}

async function callOpenAI(prompt: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;

  if (!apiKey) {
    // Offline/No-key fallback.
    return {
      text: [
        "## Response (mock)",
        "",
        "- Mini desk organizer (simple, lots of bricks/plates)",
        "- Small car (intermediate, wheels optional)",
        "- Tiny robot (simple, good for mixed colors)",
        "- Picture frame (intermediate, needs plates/tiles)",
        "- Micro castle tower (intermediate, needs bricks + a base)"
      ].join("\n"),
      model: "mock"
    };
  }
  if (!model) {
    throw new Error("OPENAI_MODEL is not set");
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: prompt
    })
  });

  if (!res.ok) {
    throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as OpenAIResponse;
  const text = extractTextFromResponses(json);
  return { text, model };
}

async function callOpenAIJson<T>(
  params: { prompt: string; schemaName: string; schema: unknown },
  opts?: { reasoningEffort?: string; maxOutputTokens?: number }
) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  if (!model) {
    throw new Error("OPENAI_MODEL is not set");
  }

  const body: Record<string, unknown> = {
    model,
    input: params.prompt,
    text: {
      format: {
        type: "json_schema",
        name: params.schemaName,
        schema: params.schema,
        strict: true
      },
      // Reduce verbosity to preserve output budget for the actual JSON/MPD.
      verbosity: "low"
    }
  };

  if (opts?.reasoningEffort) {
    body.reasoning = { effort: opts.reasoningEffort };
  }
  if (typeof opts?.maxOutputTokens === "number" && Number.isFinite(opts.maxOutputTokens) && opts.maxOutputTokens > 0) {
    body.max_output_tokens = Math.floor(opts.maxOutputTokens);
  }

  const json = await fetchResponsesJsonWithRetry({ apiKey, body, roundForLogging: 1 });
  if ((json as any)?.status === "incomplete") {
    const reason = (json as any)?.incomplete_details?.reason || "unknown";
    const debugId = writeOpenAIDebugArtifact({
      tag: `${params.schemaName}_incomplete`,
      prompt: params.prompt,
      rawResponseJson: json,
      extractedText: ""
    });
    throw new Error(
      `OpenAI response incomplete (schema=${params.schemaName}, reason=${reason}).${debugId ? ` debugId=${debugId}` : ""}`
    );
  }
  const text = extractTextFromResponses(json);
  try {
    return { parsed: parseJsonObjectFromText(text) as T, model, rawResponseJson: json, extractedText: text };
  } catch {
    const debugId = writeOpenAIDebugArtifact({
      tag: `${params.schemaName}_json_parse`,
      prompt: params.prompt,
      rawResponseJson: json,
      extractedText: text
    });
    throw new Error(
      `OpenAI returned non-JSON output (expected strict JSON).${debugId ? ` debugId=${debugId}` : ""} Raw:\n${text.slice(0, 2000)}`
    );
  }
}

async function callOpenAIJsonInput<T>(
  params: { input: unknown; schemaName: string; schema: unknown },
  opts?: { reasoningEffort?: string; maxOutputTokens?: number }
) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  if (!model) {
    throw new Error("OPENAI_MODEL is not set");
  }

  const body: Record<string, unknown> = {
    model,
    input: params.input,
    text: {
      format: {
        type: "json_schema",
        name: params.schemaName,
        schema: params.schema,
        strict: true
      },
      verbosity: "low"
    }
  };

  if (opts?.reasoningEffort) {
    body.reasoning = { effort: opts.reasoningEffort };
  }
  if (typeof opts?.maxOutputTokens === "number" && Number.isFinite(opts.maxOutputTokens) && opts.maxOutputTokens > 0) {
    body.max_output_tokens = Math.floor(opts.maxOutputTokens);
  }

  const json = await fetchResponsesJsonWithRetry({ apiKey, body, roundForLogging: 1 });
  if ((json as any)?.status === "incomplete") {
    const reason = (json as any)?.incomplete_details?.reason || "unknown";
    const debugId = writeOpenAIDebugArtifact({
      tag: `${params.schemaName}_incomplete`,
      prompt: typeof params.input === "string" ? params.input : "(non-string input)",
      rawResponseJson: json,
      extractedText: ""
    });
    throw new Error(
      `OpenAI response incomplete (schema=${params.schemaName}, reason=${reason}).${debugId ? ` debugId=${debugId}` : ""}`
    );
  }
  const text = extractTextFromResponses(json);
  try {
    return { parsed: parseJsonObjectFromText(text) as T, model, rawResponseJson: json, extractedText: text };
  } catch {
    const debugId = writeOpenAIDebugArtifact({
      tag: `${params.schemaName}_json_parse`,
      prompt: typeof params.input === "string" ? params.input : "(non-string input)",
      rawResponseJson: json,
      extractedText: text
    });
    throw new Error(
      `OpenAI returned non-JSON output (expected strict JSON).${debugId ? ` debugId=${debugId}` : ""} Raw:\n${text.slice(0, 2000)}`
    );
  }
}

// Exposed for the staged Step 2 pipeline phases (Blueprint/Architecture/Plan chunks).
export async function callOpenAIJsonSchema<T>(
  params: { prompt: string; schemaName: string; schema: unknown },
  opts?: { reasoningEffort?: string; maxOutputTokens?: number }
) {
  return await callOpenAIJson<T>(params, opts);
}

export async function generateDraftGuide(params: { goal: string; inventory: InventoryItem[] }) {
  const inv = inventoryToCompactJson(params.inventory);
  const prompt = [
    "You are an expert LEGO MOC designer and instruction writer.",
    "Given a user's brick inventory and what they want to build, produce a practical step-by-step build guide.",
    "",
    "Constraints:",
    "- Use only parts that reasonably exist in the provided inventory.",
    "- If a part is missing, suggest a substitution using parts that do exist.",
    "- Keep steps small and actionable.",
    "- Output Markdown with a numbered list of steps and occasional sub-bullets.",
    "",
    `Build goal: ${params.goal}`,
    "",
    "Inventory (JSON map of partNum -> color -> qty):",
    inv
  ].join("\n");

  return await callOpenAI(prompt);
}

export async function expandGuide(params: { goal: string; inventory: InventoryItem[]; draftGuideMarkdown: string }) {
  const inv = inventoryToCompactJson(params.inventory);
  const prompt = [
    "You are an expert LEGO instruction writer.",
    "Take the draft guide and expand it into a detailed, complete step-by-step guide.",
    "",
    "Requirements:",
    "- Preserve the intended model from the draft.",
    "- Add missing intermediate steps so a beginner can follow.",
    "- Add part callouts per step (what to place in that step).",
    "- Include basic stability checks and symmetry hints.",
    "- Output Markdown with clear step numbers and part callouts.",
    "",
    `Build goal: ${params.goal}`,
    "",
    "Inventory (JSON map of partNum -> color -> qty):",
    inv,
    "",
    "Draft guide:",
    params.draftGuideMarkdown
  ].join("\n");

  return await callOpenAI(prompt);
}

export type BuildIdea = {
  title: string;
  description: string;
  number_of_parts: number;
  difficulty: "easy" | "medium" | "hard";
  estimated_time_minutes: number;
  ldraw_mpd: string;
};

// DEPRECATED: Ideas are now generated as preview images directly (see generatePreviewImagesFromPrompt).
// This legacy type/function is kept for reference but no longer called.
type IdeaCandidateLite = { title: string; description: string; spec: { concept: string; key_features: string[]; color_palette: string[]; step_count_estimate: number } };

type ValidateLDrawToolArgs = {
  ldraw_mpd: string;
  expected_parts?: number;
  mode?: "full" | "partial" | "chunk";
  step_from?: number;
  step_to?: number;
};
type ValidateLDrawToolResult = 
  | { ok: true; similarity_score?: number }
  | { ok: false; error: string; similarity_score?: number; issues?: Array<{ type: string; message: string }> };

async function callOpenAIJsonWithToolLoop<T>(params: {
  prompt: string;
  schemaName: string;
  schema: unknown;
  reasoningEffort?: string;
  maxOutputTokens?: number;
  maxToolRounds?: number;
  onEvent?: (evt: OpenAIValidateEvent) => void;
  /** Reference image path for render comparison (enables similarity checking) */
  referenceImagePath?: string;
  /** Minimum similarity threshold (0-100). Default: 60 */
  minSimilarity?: number;
  /** Blueprint for subassembly validation */
  blueprint?: BlueprintInfo;
  /** Current subassembly being built (for targeted validation) */
  currentSubassembly?: string;
  /** 
   * Visual feedback mode: when to send rendered images back to GPT for visual review.
   * - "subassemblies": At subassembly boundaries (default)
   * - "final_only": Only on final validation
   * - "none": Never (text-only physics validation)
   */
  visualFeedbackMode?: VisualFeedbackMode;
  /** Whether this is the final validation (not an intermediate chunk) */
  isFinalValidation?: boolean;
  /** Whether this validation is at a subassembly completion boundary */
  isSubassemblyBoundary?: boolean;
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  if (!model) throw new Error("OPENAI_MODEL is not set");

  const hasReferenceImage = params.referenceImagePath && fs.existsSync(params.referenceImagePath);
  const hasBlueprint = params.blueprint && params.blueprint.subassemblies && params.blueprint.subassemblies.length > 0;
  const minSimilarity = params.minSimilarity ?? 60;
  const visualFeedbackMode = params.visualFeedbackMode ?? "subassemblies";
  
  // Determine if we should include visual feedback (rendered image) for this validation
  const shouldIncludeVisualFeedback = (() => {
    if (visualFeedbackMode === "none") return false;
    if (visualFeedbackMode === "final_only") return params.isFinalValidation === true;
    // "subassemblies" mode: include at subassembly boundaries OR final validation
    return params.isSubassemblyBoundary === true || params.isFinalValidation === true;
  })();

  const descriptionParts = [
    "Validate LDraw output with comprehensive checks:",
    "- Structure validation (syntax, FILE/NOFILE, part lines)",
    "- Continuity checks (alignment, isolated parts, extreme coordinates)"
  ];
  
  if (hasBlueprint) {
    descriptionParts.push("- Subassembly validation (position, proportions, symmetry based on blueprint)");
  }
  if (hasReferenceImage) {
    descriptionParts.push("- Render comparison (renders MPD and compares to reference image)");
  }
  
  descriptionParts.push("");
  descriptionParts.push("mode=full validates a complete MPD; mode=partial validates an assembled MPD so far; mode=chunk validates a body-only chunk (no FILE/NOFILE).");
  
  if (hasReferenceImage) {
    descriptionParts.push(`\nReturns ok=true if valid AND similarity >= ${minSimilarity}%; otherwise ok=false with error details.`);
  }
  if (hasBlueprint) {
    descriptionParts.push("\nAlso returns subassembly_positions showing where each subassembly is located in the model (top, bottom, left, right, center, etc.).");
  }
  if (shouldIncludeVisualFeedback) {
    descriptionParts.push("\nIMPORTANT: After this tool runs, you will receive a rendered image of your LDraw output. Compare it visually to the reference image (provided earlier) and fix any visual discrepancies.");
  }

  const tools = [
    {
      type: "function",
      name: "validate_ldraw_mpd",
      description: descriptionParts.join("\n"),
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["ldraw_mpd", "mode"],
        properties: {
          ldraw_mpd: { type: "string" },
          expected_parts: { type: "integer", minimum: 1 },
          mode: { type: "string", enum: ["full", "partial", "chunk"] },
          step_from: { type: "integer", minimum: 1 },
          step_to: { type: "integer", minimum: 1 }
        }
      }
    }
  ] as const;

  const maxRounds = Math.max(1, Math.min(8, params.maxToolRounds ?? 4));
  let previousResponseId: string | undefined;
  let input: unknown = params.prompt;

  for (let round = 0; round < maxRounds; round++) {
    params.onEvent?.({ type: "round_start", round: round + 1 });
    const body: Record<string, unknown> = {
      model,
      input,
      tools,
      tool_choice: "auto",
      text: {
        format: {
          type: "json_schema",
          name: params.schemaName,
          schema: params.schema,
          strict: true
        },
        verbosity: "low"
      }
    };
    if (previousResponseId) body.previous_response_id = previousResponseId;
    if (params.reasoningEffort) body.reasoning = { effort: params.reasoningEffort };
    if (typeof params.maxOutputTokens === "number" && Number.isFinite(params.maxOutputTokens) && params.maxOutputTokens > 0) {
      body.max_output_tokens = Math.floor(params.maxOutputTokens);
    }

    const json = await fetchResponsesJsonWithRetry({
      apiKey,
      body,
      roundForLogging: round + 1,
      onRetry: ({ attempt, message }) => params.onEvent?.({ type: "api_retry", round: round + 1, attempt, message })
    });
    if (json.id) previousResponseId = json.id;
    params.onEvent?.({
      type: "api_response",
      round: round + 1,
      response_id: json.id,
      status: json.status,
      model: model,
      usage: (json as any).usage
        ? {
            input_tokens: (json as any).usage?.input_tokens,
            output_tokens: (json as any).usage?.output_tokens,
            reasoning_tokens: (json as any).usage?.output_tokens_details?.reasoning_tokens,
            total_tokens: (json as any).usage?.total_tokens
          }
        : undefined
    });
    if (json.status === "incomplete") {
      const reason = json.incomplete_details?.reason || "unknown";
      const debugId = writeOpenAIDebugArtifact({
        tag: "ideas_incomplete",
        prompt: params.prompt,
        rawResponseJson: json,
        extractedText: ""
      });
      throw new Error(
        `OpenAI response incomplete (reason: ${reason}).${debugId ? ` debugId=${debugId}` : ""} ` +
          `This usually means the prompt/output budget is too large. Reduce prompt size (inventory) or increase OPENAI_MAX_OUTPUT_TOKENS.`
      );
    }

    const toolCalls = extractToolCallsFromResponses(json);
    if (toolCalls.length === 0) {
      const text = extractTextFromResponses(json);
      params.onEvent?.({ type: "round_done", round: round + 1 });
      try {
        return { parsed: parseJsonObjectFromText(text) as T, model, rawResponseJson: json, extractedText: text };
      } catch {
        const debugId = writeOpenAIDebugArtifact({
          tag: "ideas_json_parse",
          prompt: params.prompt,
          rawResponseJson: json,
          extractedText: text
        });
        throw new Error(
          `OpenAI returned non-JSON output (expected strict JSON).${debugId ? ` debugId=${debugId}` : ""} Raw:\n${text.slice(0, 2000)}`
        );
      }
    }

    // Execute tool calls locally, then send tool outputs back and continue.
    params.onEvent?.({
      type: "tool_calls",
      round: round + 1,
      calls: toolCalls.map((c) => {
        const args = parseToolArgs(c.arguments) as any;
        const mpd = typeof args.ldraw_mpd === "string" ? args.ldraw_mpd : "";
        const firstLine = mpd ? (mpd.split(/\r?\n/)[0] ?? "") : "";
        const lastNonEmpty = mpd
          ? (mpd.split(/\r?\n/).filter((l: string) => l.trim().length > 0).slice(-1)[0] ?? "")
          : "";
        return {
          id: c.id,
          name: c.name,
          expected_parts: typeof args.expected_parts === "number" ? args.expected_parts : undefined,
          ldraw_len: mpd.length,
          ldraw_first_line: firstLine,
          ldraw_last_line: lastNonEmpty
        };
      })
    });
    // Track rendered images for visual feedback
    const renderedImages: Array<{ tool_call_id: string; base64: string }> = [];
    
    const toolOutputs = toolCalls.map((c) => {
      if (c.name !== "validate_ldraw_mpd") {
        return { tool_call_id: c.id, output: JSON.stringify({ ok: false, error: `Unknown tool: ${c.name}` }) };
      }
      const parsed = parseToolArgs(c.arguments) as any;
      const args: ValidateLDrawToolArgs = {
        ldraw_mpd: typeof parsed.ldraw_mpd === "string" ? parsed.ldraw_mpd : "",
        expected_parts: typeof parsed.expected_parts === "number" ? parsed.expected_parts : undefined,
        mode: parsed.mode === "full" || parsed.mode === "partial" || parsed.mode === "chunk" ? parsed.mode : "full",
        step_from: typeof parsed.step_from === "number" ? parsed.step_from : undefined,
        step_to: typeof parsed.step_to === "number" ? parsed.step_to : undefined
      };

      // Use the unified validation module which includes:
      // - Structure validation (syntax, parts)
      // - Continuity checks (alignment, isolation, extreme coords)
      // - Subassembly validation (if blueprint provided)
      // - Render comparison (if reference image provided)
      const validationInput: RenderValidationInput = {
        ldraw_mpd: args.ldraw_mpd,
        mode: args.mode || "full",
        step_from: args.step_from,
        step_to: args.step_to,
        reference_image_path: hasReferenceImage ? params.referenceImagePath : undefined,
        min_similarity: minSimilarity,
        // Only do render comparison for partial/full modes (chunks are incomplete)
        do_render_comparison: hasReferenceImage && args.mode !== "chunk",
        // Pass blueprint for subassembly validation
        blueprint: hasBlueprint ? params.blueprint : undefined,
        current_subassembly: params.currentSubassembly
      };

      // Include rendered image if visual feedback is enabled and this isn't a chunk
      const includeRenderedImage = shouldIncludeVisualFeedback && args.mode !== "chunk";
      const result = validateRenderForToolLoop(validationInput, includeRenderedImage);
      
      // Store rendered image for visual feedback (if available)
      if (result.rendered_image_base64) {
        renderedImages.push({ tool_call_id: c.id, base64: result.rendered_image_base64 });
      }
      
      // Remove rendered_image_base64 from JSON output (it's sent as input_image instead)
      const { rendered_image_base64, ...resultForJson } = result;
      return { tool_call_id: c.id, output: JSON.stringify(resultForJson) };
    });

    // Emit summarized tool results for logging/diagnostics.
    params.onEvent?.({
      type: "tool_results",
      round: round + 1,
      results: toolOutputs.map((t) => {
        try {
          const r = JSON.parse(t.output) as ValidateLDrawToolResult;
          return { 
            tool_call_id: t.tool_call_id, 
            ok: (r as any).ok === true, 
            error: (r as any).error,
            similarity_score: (r as any).similarity_score,
            issues: (r as any).issues
          };
        } catch {
          return { tool_call_id: t.tool_call_id, ok: false, error: "Invalid tool output JSON" };
        }
      })
    });

    params.onEvent?.({ type: "round_done", round: round + 1 });

    // Responses API expects function tool outputs as "function_call_output" items.
    // (The model emits "function_call" items with a call_id; we must respond with call_id + output.)
    // 
    // When visual feedback is enabled, we also include rendered images as input_image items
    // so GPT can visually compare its output against the reference image in context.
    const inputItems: Array<Record<string, unknown>> = [];
    
    // Add tool outputs
    for (const t of toolOutputs) {
      inputItems.push({ type: "function_call_output", call_id: t.tool_call_id, output: t.output });
    }
    
    // Add rendered images for visual feedback (if any)
    if (renderedImages.length > 0) {
      // Add explanatory text before images
      inputItems.push({
        type: "input_text",
        text: "Here is the rendered output from your LDraw code. Compare it visually to the reference image you were given earlier and identify any discrepancies:"
      });
      
      // Add each rendered image
      for (const img of renderedImages) {
        inputItems.push({
          type: "input_image",
          image_url: `data:image/png;base64,${img.base64}`
        });
      }
      
      // Emit visual feedback event
      params.onEvent?.({
        type: "visual_feedback_sent",
        round: round + 1,
        image_count: renderedImages.length,
        trigger: params.isFinalValidation ? "final_validation" : "subassembly_boundary"
      });
    }
    
    input = inputItems;
  }

  throw new Error(`OpenAI tool loop exceeded max rounds (${maxRounds}) without producing a final JSON result.`);
}


// NOTE: Thumbnail and instruction generation now uses LPub3D (server-side) from the LDraw MPD output.

export async function generateLDrawMpdChunkForIdea(params: {
  title: string; // Build title
  userPrompt: string; // Original user request
  inventory: InventoryItem[];
  constraintsText?: string;
  blueprint?: unknown;
  // Chunk range is inclusive and refers to blueprint step numbers (1-based).
  stepFrom: number;
  stepTo: number;
  // The MPD built so far (assembled on server). Used as context and can be validated by tool loop.
  assembledMpdSoFar?: string;
  useValidationToolLoop?: boolean;
  onEvent?: (evt: OpenAIValidateEvent) => void;
  /** Reference image path for render-based validation (enables similarity checking) */
  referenceImagePath?: string;
  /** Minimum similarity threshold (0-100). Default: 60 */
  minSimilarity?: number;
  /** Current subassembly being built (for targeted validation) */
  currentSubassembly?: string;
  /** 
   * Visual feedback mode: when to send rendered images back to GPT for visual review.
   * - "subassemblies": At subassembly boundaries (default)
   * - "final_only": Only on final validation
   * - "none": Never (text-only physics validation)
   */
  visualFeedbackMode?: VisualFeedbackMode;
  /** Whether this chunk completes a subassembly (triggers visual feedback in "subassemblies" mode) */
  isSubassemblyBoundary?: boolean;
  /** Whether this is the final chunk (triggers visual feedback in both modes) */
  isFinalChunk?: boolean;
}): Promise<{ chunkBody: string; model: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  if (!model) throw new Error("OPENAI_MODEL is not set");

  const inv = inventoryToCompactJson(params.inventory);
  const reasoningEffort = process.env.REASONING_LEVEL;
  if (!reasoningEffort) throw new Error("REASONING_LEVEL is not set");

  const maxOutputTokensRaw = process.env.OPENAI_MAX_OUTPUT_TOKENS;
  if (!maxOutputTokensRaw) throw new Error("OPENAI_MAX_OUTPUT_TOKENS is not set");
  const maxOutputTokens = Number(maxOutputTokensRaw);
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) throw new Error("OPENAI_MAX_OUTPUT_TOKENS must be a positive number");

  const stepFrom = Math.max(1, Math.floor(Number(params.stepFrom)));
  const stepTo = Math.max(stepFrom, Math.floor(Number(params.stepTo)));
  const blueprintJson = params.blueprint != null ? JSON.stringify(params.blueprint, null, 0) : "";
  const soFar = typeof params.assembledMpdSoFar === "string" ? params.assembledMpdSoFar.trim() : "";

  const prompt = [
    "You are an expert LEGO MOC designer and LDraw author.",
    "We are generating the final build MPD in CHUNKS to avoid truncation.",
    "You must output ONLY the LDraw BODY for the requested step range (no MPD wrapper).",
    "",
    "Chunk requirements (do not violate):",
    "- Output BODY ONLY: do NOT include `0 FILE` and do NOT include the final `0 NOFILE`.",
    "- If this chunk spans multiple blueprint steps (stepFrom < stepTo), use `0 STEP` to separate them.",
    "- If this chunk is only a single step (stepFrom === stepTo), you may omit `0 STEP` or include it at the end.",
    "- Every part placement must be a type-1 line (starts with '1').",
    "- Never truncate mid-line. Keep the chunk small enough to fit output budget.",
    "",
    params.useValidationToolLoop
      ? [
          "CRITICAL VALIDATION REQUIREMENT:",
          "- You MUST call the tool validate_ldraw_mpd on BOTH:",
          "  (A) your candidate chunk body with mode=chunk and step_from/step_to set, and",
          "  (B) the assembled MPD so far (including this chunk) with mode=partial, wrapped as a complete MPD (0 FILE ... 0 NOFILE).",
          "- If validation returns ok=false, fix the output and re-validate until ok=true.",
          "- Only then return the final JSON for this chunk.",
          ""
        ].join("\n")
      : "",
    `Build title: ${params.title}`,
    `User's original request: ${params.userPrompt}`,
    "",
    blueprintJson ? "Blueprint (JSON):" : "",
    blueprintJson ? blueprintJson : "",
    blueprintJson ? "" : "",
    `Build title: ${params.title}`,
    `User's original request: ${params.userPrompt}`,
    params.constraintsText ? `\nConstraints:\n${params.constraintsText}` : "",
    "",
    `Requested step range: ${stepFrom}–${stepTo} (inclusive)`,
    "",
    soFar ? "Assembled MPD so far (wrapped, for reference):" : "",
    soFar ? soFar : "",
    "",
    "Inventory (JSON map of partNum -> color -> qty):",
    inv
  ]
    .filter((x) => x !== "")
    .join("\n");

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["chunk_body"],
    properties: {
      chunk_body: { type: "string", minLength: 10 }
    }
  } as const;

  const useToolLoop = params.useValidationToolLoop === true;
  
  // Convert blueprint to BlueprintInfo format for validation
  const blueprintForValidation: BlueprintInfo | undefined = params.blueprint ? {
    subassemblies: (params.blueprint as any).structure_plan?.subassemblies || [],
    step_outline: (params.blueprint as any).step_outline || []
  } : undefined;
  
  const resp = useToolLoop
    ? await callOpenAIJsonWithToolLoop<{ chunk_body: string }>({
        prompt,
        schemaName: "lego_ldraw_mpd_chunk",
        schema,
        reasoningEffort,
        maxOutputTokens,
        maxToolRounds: 2,
        onEvent: params.onEvent,
        referenceImagePath: params.referenceImagePath,
        minSimilarity: params.minSimilarity,
        blueprint: blueprintForValidation,
        currentSubassembly: params.currentSubassembly,
        // Visual feedback settings
        visualFeedbackMode: params.visualFeedbackMode ?? "subassemblies",
        isSubassemblyBoundary: params.isSubassemblyBoundary,
        isFinalValidation: params.isFinalChunk
      })
    : await callOpenAIJson<{ chunk_body: string }>(
        { prompt, schemaName: "lego_ldraw_mpd_chunk", schema },
        { reasoningEffort, maxOutputTokens }
      );

  const chunkBody = resp.parsed?.chunk_body;
  if (typeof chunkBody !== "string" || chunkBody.trim().length < 10) {
    throw new Error("OpenAI returned invalid chunk_body");
  }

  // Server-side validation:
  validateLDrawMpdChunkBodyOrThrow({ chunkBody, stepFrom, stepTo });
  // Also validate assembled MPD so far (including this chunk) as a partial MPD.
  const assembledParts = [soFar, chunkBody].filter(Boolean).join("\n").trim();
  const assembledCandidate = ["0 FILE model.ldr", assembledParts, "0 NOFILE"].join("\n");
  validateLDrawPartialMpdOrThrow(assembledCandidate);

  return { chunkBody: chunkBody.trim() + "\n", model: resp.model };
}

// Preview MPD generation has been removed: previews are always image-only (via generatePreviewImagePngForIdea).

export async function generatePreviewImagesFromPrompt(params: {
  userPrompt: string; // original user preferences/request
  constraints: {
    targetPartsMin?: number;
    targetPartsMax?: number;
    difficulty?: "easy" | "medium" | "hard";
    age?: number;
    buildTimeMinutes?: number;
  };
  count: number; // how many variations to generate
}): Promise<Array<{ pngBase64: string; model: string; revisedPrompt?: string }>> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const model = process.env.OPENAI_IMAGE_MODEL;
  if (!model) throw new Error("OPENAI_IMAGE_MODEL is not set");

  const constraintLines = [];
  if (params.constraints.targetPartsMin || params.constraints.targetPartsMax) {
    constraintLines.push(`Target parts range: ${params.constraints.targetPartsMin ?? "?"}–${params.constraints.targetPartsMax ?? "?"}`);
  }
  if (params.constraints.difficulty) constraintLines.push(`Difficulty: ${params.constraints.difficulty}`);
  if (params.constraints.age) constraintLines.push(`Age: ${params.constraints.age}+`);
  if (params.constraints.buildTimeMinutes) constraintLines.push(`Build time: ~${params.constraints.buildTimeMinutes} minutes`);

  const basePrompt = [
    "Create a clean, high-quality studio image of a LEGO build concept.",
    "It should look like a real LEGO model built from standard bricks (LEGO style), photographed on a plain white background.",
    "Single subject centered, no text, no watermark, no extra objects, no hands, no packaging.",
    "",
    `User request: ${params.userPrompt}`,
    ...(constraintLines.length > 0 ? ["", ...constraintLines] : [])
  ].join("\n");

  // Generate N images (OpenAI Images API doesn't batch, so we call sequentially or in parallel)
  const results = [];
  for (let i = 0; i < params.count; i++) {
    const resp = await fetchImagesJsonWithRetry({
      apiKey,
      body: {
        model,
        prompt: basePrompt,
        size: "1024x1024",
        response_format: "b64_json"
      }
    });

    const first = resp.data?.[0];
    const b64 = first?.b64_json;
    if (typeof b64 !== "string" || b64.trim().length < 100) {
      throw new Error(`OpenAI returned invalid image ${i + 1}/${params.count} (missing b64_json)`);
    }
    results.push({ pngBase64: b64, model, revisedPrompt: first?.revised_prompt });
  }

  return results;
}

export async function extractTitleFromPrompt(params: { userPrompt: string }): Promise<string> {
  // Lightweight reasoning call to extract a short, punchy title from the user's prompt.
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return "LEGO Build"; // fallback offline
  const model = process.env.OPENAI_MODEL;
  if (!model) return "LEGO Build";

  const prompt = [
    "Extract a short, punchy title (2-5 words max) for a LEGO build concept based on the user's request below.",
    "Return ONLY the title, no explanation, no quotes, no extra text.",
    "",
    `User request: ${params.userPrompt}`
  ].join("\n");

  try {
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        input: prompt,
        max_output_tokens: 50 // very short response
      })
    });

    if (!resp.ok) {
      return "LEGO Build"; // fallback on error
    }

    const json = (await resp.json()) as OpenAIResponse;
    const text = extractTextFromResponses(json);
    const cleaned = text.trim().replace(/^["']|["']$/g, ""); // strip quotes if present
    return cleaned || "LEGO Build";
  } catch {
    return "LEGO Build";
  }
}

// Legacy: now deprecated (ideas are generated as preview images directly)
export async function generatePreviewImagePngForIdea(params: {
  idea: IdeaCandidateLite;
}): Promise<{ pngBase64: string; model: string; revisedPrompt?: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const model = process.env.OPENAI_IMAGE_MODEL;
  if (!model) throw new Error("OPENAI_IMAGE_MODEL is not set");

  const specJson = JSON.stringify(params.idea.spec);
  const prompt = [
    "Create a clean, high-quality studio image of a LEGO build concept.",
    "It should look like a real LEGO model built from standard bricks (LEGO style), photographed on a plain white background.",
    "Single subject centered, no text, no watermark, no extra objects, no hands, no packaging.",
    "",
    `Title: ${params.idea.title}`,
    `Description: ${params.idea.description}`,
    `Spec (JSON): ${specJson}`
  ].join("\n");

  const resp = await fetchImagesJsonWithRetry({
    apiKey,
    body: {
      model,
      prompt,
      size: "1024x1024",
      response_format: "b64_json"
    }
  });

  const first = resp.data?.[0];
  const b64 = first?.b64_json;
  if (typeof b64 !== "string" || b64.trim().length < 100) {
    throw new Error("OpenAI returned invalid image (missing b64_json)");
  }
  return { pngBase64: b64, model, revisedPrompt: first?.revised_prompt };
}

function readFileAsDataUrl(params: { filePath: string; mimeType: string }) {
  const buf = fs.readFileSync(params.filePath);
  const b64 = buf.toString("base64");
  return `data:${params.mimeType};base64,${b64}`;
}

export type LDrawBlueprint = {
  structure_plan: {
    overview: string;
    subassemblies: Array<{ name: string; description: string }>;
  };
  step_outline: Array<{ step: number; title: string; description: string }>;
  notes: string[];
};

export async function generateBlueprintForIdea(params: {
  title: string; // Extracted title for this build
  userPrompt: string; // Original user request/preferences
  inventory: InventoryItem[];
  constraintsText?: string;
  previewImagePath?: string; // PNG path on disk (will be sent as input_image if present)
}): Promise<{ blueprint: LDrawBlueprint; model: string }> {
  const inv = inventoryToCompactJson(params.inventory);
  const constraints = params.constraintsText?.trim() ? params.constraintsText.trim() : "(none)";

  const promptText = [
    "You are an expert LEGO MOC designer and instruction planner.",
    "You will be given a user's build request and a preview image of the intended build.",
    "Produce a concise blueprint that will be used to generate an LDraw MPD with steps and instructions.",
    "",
    "Requirements:",
    "- The blueprint should reflect the preview image's silhouette and major features.",
    "- Stay faithful to the user's original request (don't add unrelated features).",
    "- Respect the user constraints (parts range, difficulty, age, build time).",
    "- Use only parts that reasonably exist in the provided inventory (you can suggest substitutions).",
    "- Keep outputs deterministic and short (no prose beyond the JSON fields).",
    "",
    `Build title: ${params.title}`,
    `User's request: ${params.userPrompt}`,
    "",
    "User constraints:",
    constraints,
    "",
    "Inventory (JSON map of partNum -> color -> qty):",
    inv
  ].join("\n");

  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: promptText }];
  if (params.previewImagePath && fs.existsSync(params.previewImagePath)) {
    const dataUrl = readFileAsDataUrl({ filePath: params.previewImagePath, mimeType: "image/png" });
    content.push({ type: "input_image", image_url: dataUrl });
  }

  // Debug artifact: write the exact prompt + a copy of the preview image (if present) for review.
  let debugInputId: string | null = null;
  if (isDebugEnabled()) {
    try {
      const dir = path.join(process.cwd(), "data", "openai-debug");
      fs.mkdirSync(dir, { recursive: true });
      const id = `blueprint_input_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      debugInputId = id;
      let copiedImageRelPath: string | null = null;
      if (params.previewImagePath && fs.existsSync(params.previewImagePath)) {
        const outImg = path.join(dir, `${id}.png`);
        fs.copyFileSync(params.previewImagePath, outImg);
        copiedImageRelPath = path.relative(process.cwd(), outImg);
      }
      const outJson = path.join(dir, `${id}.json`);
      const payload = {
        id,
        tag: "blueprint_input",
        at: new Date().toISOString(),
        note: "Blueprint vision call input (prompt + preview image copy).",
        promptText,
        previewImageOriginalPath: params.previewImagePath || null,
        previewImageCopiedPath: copiedImageRelPath,
        // Include the exact message array we send (without duplicating the full prompt text and
        // without embedding the data-url image to keep file size sane)
        requestShape: {
          role: "user",
          content: [
            { type: "input_text", text: "(see promptText field)" },
            params.previewImagePath && fs.existsSync(params.previewImagePath)
              ? { type: "input_image", image_url: "(data-url omitted; see copied PNG path)" }
              : null
          ].filter(Boolean)
        }
      };
      fs.writeFileSync(outJson, JSON.stringify(payload, null, 2), "utf8");
      // eslint-disable-next-line no-console
      console.error(`[openai-debug] wrote ${outJson}`);
    } catch {
      // ignore debug artifact failures
    }
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["structure_plan", "step_outline", "notes"],
    properties: {
      structure_plan: {
        type: "object",
        additionalProperties: false,
        required: ["overview", "subassemblies"],
        properties: {
          overview: { type: "string", minLength: 10 },
          subassemblies: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "description"],
              properties: {
                name: { type: "string", minLength: 1 },
                description: { type: "string", minLength: 5 }
              }
            }
          }
        }
      },
      step_outline: {
        type: "array",
        minItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["step", "title", "description"],
          properties: {
            step: { type: "integer", minimum: 1 },
            title: { type: "string", minLength: 1 },
            description: { type: "string", minLength: 5 }
          }
        }
      },
      notes: { type: "array", items: { type: "string" } }
    }
  } as const;

  const maxOutputTokensRaw = process.env.OPENAI_MAX_OUTPUT_TOKENS;
  if (!maxOutputTokensRaw) throw new Error("OPENAI_MAX_OUTPUT_TOKENS is not set");
  const maxOutputTokens = Number(maxOutputTokensRaw);
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new Error("OPENAI_MAX_OUTPUT_TOKENS must be a positive number");
  }

  const baseReasoning = (process.env.REASONING_LEVEL || "medium").toLowerCase();
  // Blueprint must be at least medium effort (per product requirement).
  const reasoningEffort = baseReasoning === "high" ? "high" : "medium";

  const startedAtMs = Date.now();
  const resp = await callOpenAIJsonInput<LDrawBlueprint>(
    { input: [{ role: "user", content }], schemaName: "lego_ldraw_blueprint", schema },
    { reasoningEffort, maxOutputTokens: Math.floor(maxOutputTokens) }
  );
  const durationMs = Date.now() - startedAtMs;

  if (isDebugEnabled()) {
    try {
      const dir = path.join(process.cwd(), "data", "openai-debug");
      fs.mkdirSync(dir, { recursive: true });
      const id = `blueprint_response_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const outJson = path.join(dir, `${id}.json`);
      const raw = resp.rawResponseJson as any;
      const payload = {
        id,
        tag: "blueprint_response",
        at: new Date().toISOString(),
        debugInputId,
        durationMs,
        model: resp.model,
        responseId: raw?.id ?? null,
        status: raw?.status ?? null,
        usage: raw?.usage ?? null
      };
      fs.writeFileSync(outJson, JSON.stringify(payload, null, 2), "utf8");
      // eslint-disable-next-line no-console
      console.error(`[openai-debug] wrote ${outJson}`);
    } catch {
      // ignore debug artifact failures
    }
  }

  return { blueprint: resp.parsed as LDrawBlueprint, model: resp.model };
}


