import { InventoryItem, type IdeaCandidate as IdeaCandidateModel } from "@/lib/models";
import { validateLDrawMpdOrThrow } from "@/lib/ldrawValidate";
import fs from "node:fs";
import path from "node:path";

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
  | { type: "tool_results"; round: number; results: Array<{ tool_call_id: string; ok: boolean; error?: string }> }
  | { type: "round_done"; round: number };

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
  const text = extractTextFromResponses(json);
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

type IdeaCandidateLite = Pick<IdeaCandidateModel, "title" | "description" | "spec">;

type ValidateLDrawToolArgs = { ldraw_mpd: string; expected_parts?: number };
type ValidateLDrawToolResult = { ok: true } | { ok: false; error: string };

async function callOpenAIJsonWithToolLoop<T>(params: {
  prompt: string;
  schemaName: string;
  schema: unknown;
  reasoningEffort?: string;
  maxOutputTokens?: number;
  maxToolRounds?: number;
  onEvent?: (evt: OpenAIValidateEvent) => void;
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  if (!model) throw new Error("OPENAI_MODEL is not set");

  const tools = [
    {
      type: "function",
      name: "validate_ldraw_mpd",
      description:
        "Validate an LDraw MPD string for completeness (not truncated), reasonable step count, and reasonable part placement count. Returns ok=true if valid; otherwise ok=false with an error message.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["ldraw_mpd"],
        properties: {
          ldraw_mpd: { type: "string" },
          expected_parts: { type: "integer", minimum: 1 }
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
    const toolOutputs = toolCalls.map((c) => {
      if (c.name !== "validate_ldraw_mpd") {
        return { tool_call_id: c.id, output: JSON.stringify({ ok: false, error: `Unknown tool: ${c.name}` }) };
      }
      const parsed = parseToolArgs(c.arguments) as any;
      const args: ValidateLDrawToolArgs = {
        ldraw_mpd: typeof parsed.ldraw_mpd === "string" ? parsed.ldraw_mpd : "",
        expected_parts: typeof parsed.expected_parts === "number" ? parsed.expected_parts : undefined
      };

      let result: ValidateLDrawToolResult;
      try {
        validateLDrawMpdOrThrow({ ldrawMpd: String(args.ldraw_mpd || ""), expectedParts: args.expected_parts });
        result = { ok: true };
      } catch (e) {
        result = { ok: false, error: e instanceof Error ? e.message : "Validation failed" };
      }
      return { tool_call_id: c.id, output: JSON.stringify(result) };
    });

    // Emit summarized tool results for logging/diagnostics.
    params.onEvent?.({
      type: "tool_results",
      round: round + 1,
      results: toolOutputs.map((t) => {
        try {
          const r = JSON.parse(t.output) as ValidateLDrawToolResult;
          return { tool_call_id: t.tool_call_id, ok: (r as any).ok === true, error: (r as any).error };
        } catch {
          return { tool_call_id: t.tool_call_id, ok: false, error: "Invalid tool output JSON" };
        }
      })
    });

    params.onEvent?.({ type: "round_done", round: round + 1 });

    // Responses API expects function tool outputs as "function_call_output" items.
    // (The model emits "function_call" items with a call_id; we must respond with call_id + output.)
    input = toolOutputs.map((t) => ({ type: "function_call_output", call_id: t.tool_call_id, output: t.output }));
  }

  throw new Error(`OpenAI tool loop exceeded max rounds (${maxRounds}) without producing a final JSON result.`);
}

export async function generateBuildIdeasStructured(params: {
  inventory: InventoryItem[];
  preferences?: string;
  targetPartsMin?: number;
  targetPartsMax?: number;
  difficulty?: "easy" | "medium" | "hard";
  age?: number;
  buildTimeMinutes?: number;
  count?: number; // defaults to 2
  onEvent?: (evt: OpenAIValidateEvent) => void;
}): Promise<{ ideas: IdeaCandidateModel[]; model: string }> {
  const inv = inventoryToCompactJson(params.inventory);
  const preferenceLine = params.preferences?.trim() ? params.preferences.trim() : "(none)";
  const reasoningEffort = process.env.REASONING_LEVEL;
  if (!reasoningEffort) {
    throw new Error("REASONING_LEVEL is not set");
  }
  const count = typeof params.count === "number" && Number.isFinite(params.count) ? Math.floor(params.count) : 2;
  const ideaCount = Math.max(1, Math.min(5, count));
  const constraints = [
    params.targetPartsMin || params.targetPartsMax
      ? `Target parts range: ${params.targetPartsMin ?? "?"}–${params.targetPartsMax ?? "?"}`
      : "Target parts range: (not specified)",
    params.difficulty ? `Difficulty: ${params.difficulty}` : "Difficulty: (not specified)",
    params.age ? `Age: ${params.age}+` : "Age: (not specified)"
    ,
    params.buildTimeMinutes ? `Build time target: ${params.buildTimeMinutes} minutes` : "Build time target: (not specified)"
  ].join("\n");

  const promptParts: string[] = [
    "You are an expert LEGO MOC designer.",
    "Given a user's LEGO parts inventory, propose build ideas that are realistic with the available parts and the user's optional constraints.",
    "",
    `Return exactly ${ideaCount} ideas.`,
    "Each idea must include:",
    "- title: short, catchy (string)",
    "- description: 1–2 short sentences (string). Do NOT list parts, do NOT include bullet points, and do NOT mention the user's inventory explicitly.",
    "- estimated_time_minutes: integer rough build time estimate (minutes). Aim for the user's build time target if provided.",
    "- spec: a compact build spec object to drive later instruction generation (concept + key_features + color_palette + step_count_estimate).",
    "",
    "Make ideas diverse (different concepts).",
    "",
    `User preferences: ${preferenceLine}`,
    "",
    "User constraints:",
    constraints,
    "",
    "Inventory (JSON map of partNum -> color -> qty):",
    inv
  ];

  const prompt = promptParts.join("\n");

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["ideas"],
    properties: {
      ideas: {
        type: "array",
        minItems: 1,
        maxItems: ideaCount,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "description", "estimated_time_minutes", "spec"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 120 },
            description: { type: "string", minLength: 1, maxLength: 300 },
            estimated_time_minutes: { type: "integer", minimum: 1, maximum: 1440 },
            spec: {
              type: "object",
              additionalProperties: false,
              // NOTE: OpenAI strict schema requires required[] to include every key in properties.
              required: ["concept", "key_features", "color_palette", "step_count_estimate"],
              properties: {
                concept: { type: "string", minLength: 1, maxLength: 120 },
                key_features: { type: "array", items: { type: "string", minLength: 1, maxLength: 80 }, minItems: 1, maxItems: 8 },
                color_palette: { type: "array", items: { type: "string", minLength: 1, maxLength: 40 }, minItems: 1, maxItems: 6 },
                step_count_estimate: { type: "integer", minimum: 4, maximum: 60 }
              }
            }
          }
        }
      }
    }
  } as const;

  function validateIdeasPayload(payload: unknown): IdeaCandidateModel[] {
    if (typeof payload !== "object" || payload === null) throw new Error("OpenAI returned non-object JSON");
    const ideas = (payload as { ideas?: unknown }).ideas;
    if (!Array.isArray(ideas) || ideas.length === 0) throw new Error("OpenAI returned JSON without a non-empty ideas array");

    const normalized: IdeaCandidateModel[] = [];
    for (const raw of ideas) {
      if (typeof raw !== "object" || raw === null) throw new Error("OpenAI returned an invalid idea entry");
      const idea = raw as any;
      if (!idea.title || typeof idea.title !== "string") throw new Error("Idea missing title");
      if (!idea.description || typeof idea.description !== "string") throw new Error("Idea missing description");
      if (typeof idea.estimated_time_minutes !== "number" || !Number.isFinite(idea.estimated_time_minutes))
        throw new Error("Idea missing estimated_time_minutes");
      const spec = idea.spec;
      if (typeof spec !== "object" || spec == null) throw new Error("Idea missing spec");
      if (typeof spec.concept !== "string" || !spec.concept.trim()) throw new Error("Idea spec missing concept");
      if (!Array.isArray(spec.key_features) || spec.key_features.length === 0) throw new Error("Idea spec missing key_features");
      if (!Array.isArray(spec.color_palette) || spec.color_palette.length === 0) throw new Error("Idea spec missing color_palette");
      if (typeof spec.step_count_estimate !== "number" || !Number.isFinite(spec.step_count_estimate))
        throw new Error("Idea spec missing step_count_estimate");
      normalized.push({
        title: String(idea.title).trim(),
        description: String(idea.description).trim(),
        estimated_time_minutes: Math.max(1, Math.min(1440, Math.floor(Number(idea.estimated_time_minutes)))),
        spec: {
          concept: String(spec.concept).trim(),
          key_features: (spec.key_features as unknown[]).map((x) => String(x)).filter((s) => s.trim().length > 0).slice(0, 8),
          color_palette: (spec.color_palette as unknown[]).map((x) => String(x)).filter((s) => s.trim().length > 0).slice(0, 6),
          step_count_estimate: Math.max(4, Math.min(60, Math.floor(Number(spec.step_count_estimate))))
        }
      });
    }
    return normalized.slice(0, ideaCount);
  }

  // LDraw MPD is verbose; give the model enough output budget to avoid truncation.
  const maxOutputTokensRaw = process.env.OPENAI_MAX_OUTPUT_TOKENS;
  if (!maxOutputTokensRaw) {
    throw new Error("OPENAI_MAX_OUTPUT_TOKENS is not set");
  }
  const maxOutputTokens = Number(maxOutputTokensRaw);
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new Error("OPENAI_MAX_OUTPUT_TOKENS must be a positive number");
  }

  const { parsed, model, rawResponseJson, extractedText } = await callOpenAIJson<{ ideas: IdeaCandidateModel[] }>(
    { prompt, schemaName: "lego_build_ideas", schema },
    { reasoningEffort, maxOutputTokens }
  );

  try {
    return { ideas: validateIdeasPayload(parsed), model };
  } catch (ve) {
    const debugId = writeOpenAIDebugArtifact({
      tag: "ideas_validation",
      prompt,
      rawResponseJson,
      extractedText,
      note: ve instanceof Error ? ve.message : "Validation failed"
    });
    throw new Error(
      `OpenAI ideas validation failed (schema-enforced).${debugId ? ` debugId=${debugId}` : ""} ${ve instanceof Error ? ve.message : ""}`.trim()
    );
  }
}

// NOTE: Thumbnail and instruction generation now uses LPub3D (server-side) from the LDraw MPD output.

export async function generateLDrawMpdForIdea(params: {
  inventory: InventoryItem[];
  preferences?: string;
  constraintsText?: string;
  idea: IdeaCandidateLite;
  useValidationToolLoop?: boolean;
  onEvent?: (evt: OpenAIValidateEvent) => void;
}): Promise<{ ldraw_mpd: string; model: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  if (!model) throw new Error("OPENAI_MODEL is not set");

  const inv = inventoryToCompactJson(params.inventory);
  const preferenceLine = params.preferences?.trim() ? params.preferences.trim() : "(none)";
  const reasoningEffort = process.env.REASONING_LEVEL;
  if (!reasoningEffort) throw new Error("REASONING_LEVEL is not set");

  const maxOutputTokensRaw = process.env.OPENAI_MAX_OUTPUT_TOKENS;
  if (!maxOutputTokensRaw) throw new Error("OPENAI_MAX_OUTPUT_TOKENS is not set");
  const maxOutputTokens = Number(maxOutputTokensRaw);
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) throw new Error("OPENAI_MAX_OUTPUT_TOKENS must be a positive number");

  const specJson = JSON.stringify(params.idea.spec);

  const prompt = [
    "You are an expert LEGO MOC designer and LDraw author.",
    "Given a user's inventory and a selected idea spec, generate a complete, valid LDraw MPD file for the FULL finished build.",
    "",
    "MPD requirements (do not violate):",
    "- Start the main model with: 0 FILE model.ldr",
    "- Use '0 STEP' between steps (aim for at least 8 steps unless the model is very small).",
    "- Every part you add should be a type-1 placement line (starts with '1').",
    "- Do NOT truncate the MPD. The last non-empty line MUST be: 0 NOFILE",
    "- Keep geometry plausible and stable. Use common parts; do not invent part numbers.",
    "- Keep the MPD concise enough to fit in the response (if needed, reduce complexity/part count).",
    "",
    params.useValidationToolLoop
      ? [
          "CRITICAL VALIDATION REQUIREMENT:",
          "- You MUST call the tool validate_ldraw_mpd on your candidate MPD before returning JSON.",
          "- If validation returns ok=false, fix and re-validate until ok=true.",
          "- Only then return the final JSON.",
          ""
        ].join("\n")
      : "",
    `Selected idea title: ${params.idea.title}`,
    `Selected idea description: ${params.idea.description}`,
    `Selected idea spec (JSON): ${specJson}`,
    "",
    `User preferences: ${preferenceLine}`,
    params.constraintsText ? `\nConstraints:\n${params.constraintsText}` : "",
    "",
    "Inventory (JSON map of partNum -> color -> qty):",
    inv
  ]
    .filter((x) => x !== "")
    .join("\n");

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["ldraw_mpd"],
    properties: {
      ldraw_mpd: { type: "string", minLength: 50 }
    }
  } as const;

  const useToolLoop = params.useValidationToolLoop === true;

  const resp = useToolLoop
    ? await callOpenAIJsonWithToolLoop<{ ldraw_mpd: string }>({
        prompt,
        schemaName: "lego_ldraw_mpd",
        schema,
        reasoningEffort,
        maxOutputTokens,
        maxToolRounds: 2,
        onEvent: params.onEvent
      })
    : await callOpenAIJson<{ ldraw_mpd: string }>(
        { prompt, schemaName: "lego_ldraw_mpd", schema },
        { reasoningEffort, maxOutputTokens }
      );

  const mpd = resp.parsed?.ldraw_mpd;
  if (typeof mpd !== "string" || mpd.trim().length < 50) {
    throw new Error("OpenAI returned invalid ldraw_mpd");
  }
  // Always enforce server-side validation too (tool loop can be disabled).
  validateLDrawMpdOrThrow({ ldrawMpd: mpd });

  return { ldraw_mpd: mpd, model: resp.model };
}

export async function generatePreviewMpdForIdea(params: {
  inventory: InventoryItem[];
  idea: IdeaCandidateLite;
}): Promise<{ ldraw_mpd: string; model: string }> {
  const reasoningEffort = process.env.PREVIEW_REASONING_LEVEL || process.env.REASONING_LEVEL;
  if (!reasoningEffort) throw new Error("REASONING_LEVEL is not set (or set PREVIEW_REASONING_LEVEL)");

  const maxOutputTokensRaw = process.env.PREVIEW_MAX_OUTPUT_TOKENS || process.env.OPENAI_MAX_OUTPUT_TOKENS;
  if (!maxOutputTokensRaw) throw new Error("OPENAI_MAX_OUTPUT_TOKENS is not set (or set PREVIEW_MAX_OUTPUT_TOKENS)");
  const maxOutputTokensEnv = Number(maxOutputTokensRaw);
  if (!Number.isFinite(maxOutputTokensEnv) || maxOutputTokensEnv <= 0) {
    throw new Error("OPENAI_MAX_OUTPUT_TOKENS (or PREVIEW_MAX_OUTPUT_TOKENS) must be a positive number");
  }
  // Preview should be small by instruction, not by token cap (reasoning can otherwise consume the entire budget).
  const maxOutputTokens = Math.floor(maxOutputTokensEnv);

  const inv = inventoryToCompactJson(params.inventory);
  const specJson = JSON.stringify(params.idea.spec);

  const prompt = [
    "You are an expert LEGO MOC designer and LDraw author.",
    "Generate a MICRO preview LDraw MPD that represents the idea at a very small scale for a thumbnail render.",
    "",
    "Constraints:",
    "- Keep it tiny: <= 8 steps, <= ~35 part placements.",
    "- Must be a complete MPD with 0 FILE model.ldr and final 0 NOFILE.",
    "- Include 0 STEP directives and plausible geometry.",
    "",
    `Selected idea title: ${params.idea.title}`,
    `Selected idea description: ${params.idea.description}`,
    `Selected idea spec (JSON): ${specJson}`,
    "",
    "Inventory (JSON map of partNum -> color -> qty):",
    inv
  ].join("\n");

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["ldraw_mpd"],
    properties: {
      ldraw_mpd: { type: "string", minLength: 50 }
    }
  } as const;

  const resp = await callOpenAIJson<{ ldraw_mpd: string }>(
    { prompt, schemaName: "lego_preview_mpd", schema },
    { reasoningEffort, maxOutputTokens }
  );

  const mpd = resp.parsed?.ldraw_mpd;
  if (typeof mpd !== "string" || mpd.trim().length < 50) throw new Error("OpenAI returned invalid preview ldraw_mpd");
  return { ldraw_mpd: mpd, model: resp.model };
}


