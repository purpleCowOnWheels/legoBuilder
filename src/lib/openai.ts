import { InventoryItem, type IdeaCandidate as IdeaCandidateModel } from "@/lib/models";
import { validateLDrawMpdOrThrow } from "@/lib/ldrawValidate";
import { validateLDrawMpdChunkBodyOrThrow, validateLDrawPartialMpdOrThrow } from "@/lib/ldrawValidate";
import { validateRenderForToolLoop, type RenderValidationInput, type BlueprintInfo, type ToolLoopValidationResult } from "@/lib/renderValidation";
import { TokenTracker, calculateCost, formatUsageEntry, type TokenUsage } from "@/lib/tokenUsage";
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

type ToolCall = { id: string; name: string; arguments: unknown };

/** Validation target describes what the validation is checking */
export type ValidationTarget = 
  | "chunk"           // Body-only LDraw fragment (no FILE/NOFILE)
  | "partial_build"   // Assembled MPD so far (incomplete model)
  | "subassembly"     // Complete subassembly boundary
  | "final_model";    // Complete final model

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
        /** What's being validated: chunk, partial_build, subassembly, or final_model */
        validation_target?: ValidationTarget;
        /** Validation mode from the tool args */
        mode?: "chunk" | "partial" | "full";
        /** Step range being validated (if applicable) */
        step_range?: { from?: number; to?: number };
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
        /** What was validated */
        validation_target?: ValidationTarget;
        ok: boolean; 
        error?: string;
        similarity_score?: number;
        /** Whether render comparison was performed */
        render_compared?: boolean;
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
  const endpoint = "https://api.openai.com/v1/responses";
  
  // Log the request being sent
  const summary = summarizeRequestBody(params.body);
  logOpenAI("info", `API Request [round ${params.roundForLogging}]: model=${params.body.model}, input=${summary.inputType}(len=${summary.inputLength}), images=${summary.imageCount}, tools=${params.body.tools ? (params.body.tools as unknown[]).length : 0}`);
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startMs = Date.now();
    try {
      // Hard timeout so a single OpenAI request can't hang indefinitely.
      // Extended reasoning + tool loops + visual feedback can take longer.
      // Use environment variable or default based on context.
      const defaultTimeout = 360_000; // 6 minutes default for reasoning models
      const timeoutMs = process.env.OPENAI_TIMEOUT_MS 
        ? parseInt(process.env.OPENAI_TIMEOUT_MS, 10) 
        : defaultTimeout;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(endpoint, {
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
      const durationMs = Date.now() - startMs;
      
      if (!res.ok) {
        logOpenAI("error", `API Error [round ${params.roundForLogging}]: status=${res.status}, duration=${durationMs}ms`, rawText.slice(0, 500));
        
        // Retry transient OpenAI/server issues.
        if (res.status >= 500 && attempt < maxAttempts) {
          params.onRetry?.({ attempt, message: `OpenAI ${res.status} (server error). Retrying…` });
          const delayMs = attempt === 1 ? 1000 : 3000;
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        throw new Error(`OpenAI error ${res.status}: ${rawText}`);
      }

      const responseJson = JSON.parse(rawText) as OpenAIResponse;
      const usage = (responseJson as any).usage;
      
      // Log the response
      logOpenAI("info", `API Response [round ${params.roundForLogging}]: status=${responseJson.status}, duration=${durationMs}ms, tokens=${usage?.total_tokens || "?"}`);
      
      // Write full API call artifact for debugging
      writeApiCallArtifact({
        tag: `api_call_round_${params.roundForLogging}`,
        endpoint,
        requestBody: params.body,
        responseJson,
        responseStatus: responseJson.status,
        durationMs,
        round: params.roundForLogging
      });

      return responseJson;
    } catch (e) {
      const durationMs = Date.now() - startMs;
      const isAbort = e instanceof Error && (e.name === "AbortError" || /aborted/i.test(e.message));
      
      logOpenAI("warn", `API Error [round ${params.roundForLogging}, attempt ${attempt}]: ${e instanceof Error ? e.message : "unknown"}, duration=${durationMs}ms`);
      
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

// Always log OpenAI communication to console (regardless of DEBUG_OPENAI)
// DEBUG_OPENAI controls whether full artifacts are written to disk
function logOpenAI(level: "info" | "debug" | "warn" | "error", message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const prefix = `[openai ${timestamp}]`;
  
  if (level === "error") {
    // eslint-disable-next-line no-console
    console.error(`${prefix} ${message}`, data ? JSON.stringify(data, null, 2).slice(0, 2000) : "");
  } else if (level === "warn") {
    // eslint-disable-next-line no-console
    console.warn(`${prefix} ${message}`, data ? JSON.stringify(data, null, 2).slice(0, 1000) : "");
  } else if (level === "debug" && isDebugEnabled()) {
    // eslint-disable-next-line no-console
    console.log(`${prefix} [debug] ${message}`, data ? JSON.stringify(data, null, 2).slice(0, 2000) : "");
  } else if (level === "info") {
    // eslint-disable-next-line no-console
    console.log(`${prefix} ${message}`);
  }
}

function getDebugDir() {
  const dir = path.join(process.cwd(), "data", "openai-debug");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function generateArtifactId(tag: string) {
  return `${tag}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function writeOpenAIDebugArtifact(params: {
  tag: string;
  prompt: string;
  rawResponseJson: unknown;
  extractedText: string;
  note?: string;
}) {
  if (!isDebugEnabled()) return null as string | null;

  const dir = getDebugDir();
  const id = generateArtifactId(params.tag);
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
  logOpenAI("info", `Debug artifact written: ${filePath}`);
  return id;
}

/**
 * Write a comprehensive API call log (request + response)
 * Always writes when DEBUG_OPENAI=1
 */
function writeApiCallArtifact(params: {
  tag: string;
  endpoint: string;
  requestBody: Record<string, unknown>;
  responseJson: unknown;
  responseStatus?: string;
  durationMs: number;
  round?: number;
  note?: string;
}) {
  if (!isDebugEnabled()) return null as string | null;

  const dir = getDebugDir();
  const id = generateArtifactId(params.tag);
  const filePath = path.join(dir, `${id}.json`);

  // Summarize request body for logging (avoid huge image data in main payload)
  const requestSummary = summarizeRequestBody(params.requestBody);

  const payload = {
    id,
    tag: params.tag,
    at: new Date().toISOString(),
    endpoint: params.endpoint,
    round: params.round,
    durationMs: params.durationMs,
    note: params.note,
    request: {
      model: params.requestBody.model,
      tools: params.requestBody.tools ? (params.requestBody.tools as unknown[]).length + " tools" : undefined,
      hasImages: requestSummary.imageCount > 0,
      imageCount: requestSummary.imageCount,
      inputType: requestSummary.inputType,
      inputLength: requestSummary.inputLength,
      // Full request body (with images truncated)
      body: truncateImagesInBody(params.requestBody)
    },
    response: {
      status: params.responseStatus,
      // Full response (usually no images)
      json: params.responseJson
    }
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  logOpenAI("info", `API call artifact: ${filePath}`);
  return id;
}

/**
 * Save an image being sent to GPT (for validation feedback, etc.)
 */
function saveImageArtifact(params: {
  tag: string;
  base64: string;
  purpose: string;
  round?: number;
  toolCallId?: string;
}): string | null {
  if (!isDebugEnabled()) return null;

  const dir = getDebugDir();
  const id = generateArtifactId(params.tag);
  const imagePath = path.join(dir, `${id}.png`);
  const metaPath = path.join(dir, `${id}_meta.json`);

  // Write the image
  const buffer = Buffer.from(params.base64, "base64");
  fs.writeFileSync(imagePath, buffer);

  // Write metadata
  const meta = {
    id,
    tag: params.tag,
    at: new Date().toISOString(),
    purpose: params.purpose,
    round: params.round,
    toolCallId: params.toolCallId,
    imagePath: path.relative(process.cwd(), imagePath),
    imageSizeBytes: buffer.length
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");

  logOpenAI("info", `Image artifact saved: ${imagePath} (${buffer.length} bytes, purpose: ${params.purpose})`);
  return id;
}

/**
 * Summarize request body for logging
 */
function summarizeRequestBody(body: Record<string, unknown>): {
  inputType: string;
  inputLength: number;
  imageCount: number;
} {
  let imageCount = 0;
  let inputType = "unknown";
  let inputLength = 0;

  const input = body.input;
  if (typeof input === "string") {
    inputType = "string";
    inputLength = input.length;
  } else if (Array.isArray(input)) {
    inputType = "array";
    inputLength = input.length;
    // Count images in input array
    for (const item of input) {
      if (typeof item === "object" && item !== null) {
        const obj = item as Record<string, unknown>;
        if (obj.type === "input_image" || obj.type === "image_url") {
          imageCount++;
        }
        // Check for messages with content arrays
        if (obj.content && Array.isArray(obj.content)) {
          for (const c of obj.content as unknown[]) {
            if (typeof c === "object" && c !== null) {
              const cc = c as Record<string, unknown>;
              if (cc.type === "input_image" || cc.type === "image_url") {
                imageCount++;
              }
            }
          }
        }
      }
    }
  }

  return { inputType, inputLength, imageCount };
}

/**
 * Truncate image data URLs in request body for logging (preserve structure but reduce size)
 */
function truncateImagesInBody(body: Record<string, unknown>): Record<string, unknown> {
  const truncateValue = (val: unknown): unknown => {
    if (typeof val === "string" && val.startsWith("data:image/")) {
      // Truncate data URLs but keep enough to identify them
      return val.slice(0, 50) + `...[truncated ${val.length} chars]`;
    }
    if (Array.isArray(val)) {
      return val.map(truncateValue);
    }
    if (typeof val === "object" && val !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val)) {
        out[k] = truncateValue(v);
      }
      return out;
    }
    return val;
  };

  return truncateValue(body) as Record<string, unknown>;
}

/**
 * Write tool call/result artifacts for debugging
 */
function writeToolArtifact(params: {
  tag: string;
  round: number;
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
  toolResults?: Array<{ tool_call_id: string; output: string }>;
  note?: string;
}) {
  if (!isDebugEnabled()) return null as string | null;

  const dir = getDebugDir();
  const id = generateArtifactId(params.tag);
  const filePath = path.join(dir, `${id}.json`);

  const payload = {
    id,
    tag: params.tag,
    at: new Date().toISOString(),
    round: params.round,
    note: params.note,
    toolCalls: params.toolCalls,
    toolResults: params.toolResults?.map(r => {
      // Parse the output JSON for readability
      try {
        return { ...r, outputParsed: JSON.parse(r.output) };
      } catch {
        return r;
      }
    })
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  logOpenAI("debug", `Tool artifact: ${filePath}`);
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

  // Log the request
  logOpenAI("info", `callOpenAIJson: schema=${params.schemaName}, model=${model}, promptLen=${params.prompt.length}`);

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
    logOpenAI("error", `callOpenAIJson: Response incomplete (schema=${params.schemaName}, reason=${reason})`);
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
    const parsed = parseJsonObjectFromText(text) as T;
    logOpenAI("info", `callOpenAIJson: Success (schema=${params.schemaName})`);
    return { parsed, model, rawResponseJson: json, extractedText: text };
  } catch {
    logOpenAI("error", `callOpenAIJson: JSON parse failed (schema=${params.schemaName})`);
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

  // Log the request
  const inputSummary = summarizeRequestBody({ input: params.input });
  logOpenAI("info", `callOpenAIJsonInput: schema=${params.schemaName}, model=${model}, input=${inputSummary.inputType}(len=${inputSummary.inputLength}), images=${inputSummary.imageCount}`);

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
    logOpenAI("error", `callOpenAIJsonInput: Response incomplete (schema=${params.schemaName}, reason=${reason})`);
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
    const parsed = parseJsonObjectFromText(text) as T;
    logOpenAI("info", `callOpenAIJsonInput: Success (schema=${params.schemaName})`);
    return { parsed, model, rawResponseJson: json, extractedText: text };
  } catch {
    logOpenAI("error", `callOpenAIJsonInput: JSON parse failed (schema=${params.schemaName})`);
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

// Simplified tool args - GPT just provides chunk body, server determines validation
type ValidateLDrawToolArgs = {
  chunk_body: string;
};
type ValidateLDrawToolResult = 
  | { ok: true; similarity_score?: number; validation_level?: string }
  | { ok: false; error: string; similarity_score?: number; validation_level?: string; issues?: Array<{ type: string; message: string }> };

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
  /** Assembled MPD so far (previous chunks) - server uses this to wrap the new chunk */
  assembledMpdSoFar?: string;
  /** Step range being generated */
  stepFrom?: number;
  stepTo?: number;
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  if (!model) throw new Error("OPENAI_MODEL is not set");

  const hasReferenceImage = params.referenceImagePath && fs.existsSync(params.referenceImagePath);
  const minSimilarity = params.minSimilarity ?? 60;
  const visualFeedbackMode = params.visualFeedbackMode ?? "subassemblies";
  
  // Determine if we should include visual feedback (rendered image) for this validation
  const shouldIncludeVisualFeedback = (() => {
    if (visualFeedbackMode === "none") return false;
    if (visualFeedbackMode === "final_only") return params.isFinalValidation === true;
    // "subassemblies" mode: include at subassembly boundaries OR final validation
    return params.isSubassemblyBoundary === true || params.isFinalValidation === true;
  })();
  
  // Determine validation level for this chunk (server decides, not GPT)
  const validationLevel: "structure_only" | "full_validation" = 
    (params.isSubassemblyBoundary || params.isFinalValidation) ? "full_validation" : "structure_only";
  
  // Build simple tool description
  const descriptionParts = [
    "Validate your LDraw chunk. Just pass your chunk_body (the raw LDraw lines you generated).",
    "The server will automatically:",
    "- Combine it with previous chunks",
    "- Run structure validation (syntax, part lines, coordinates)",
    "- Run continuity checks (alignment, isolated parts)"
  ];
  
  if (validationLevel === "full_validation") {
    descriptionParts.push("- Run render comparison against reference image");
    descriptionParts.push("- Check subassembly positioning");
    if (shouldIncludeVisualFeedback) {
      descriptionParts.push("");
      descriptionParts.push("After validation, you will receive a rendered image. Compare it to the reference and fix any issues.");
    }
  }
  
  descriptionParts.push("");
  descriptionParts.push("Returns ok=true if valid, ok=false with error details if not.");

  const tools = [
    {
      type: "function",
      name: "validate_ldraw_chunk",
      description: descriptionParts.join("\n"),
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["chunk_body"],
        properties: {
          chunk_body: { 
            type: "string",
            description: "Your LDraw chunk body (raw part lines, no FILE/NOFILE wrapper)"
          }
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
    // Log full tool call arguments for debugging
    logOpenAI("info", `Tool calls received [round ${round + 1}]: ${toolCalls.length} call(s)`);
    for (const c of toolCalls) {
      const args = parseToolArgs(c.arguments) as any;
      const chunkBody = typeof args.chunk_body === "string" ? args.chunk_body : "";
      logOpenAI("info", `  Tool ${c.name} (${c.id}): chunk_body=${chunkBody.length} chars`);
      logOpenAI("debug", `  Full args for ${c.id}:`, args);
    }
    
    // Write tool call artifact with full arguments
    writeToolArtifact({
      tag: `tool_calls_round_${round + 1}`,
      round: round + 1,
      toolCalls: toolCalls.map(c => ({
        id: c.id,
        name: c.name,
        arguments: parseToolArgs(c.arguments)
      })),
      note: `${toolCalls.length} tool call(s) from GPT - validation level: ${validationLevel}`
    });
    
    // Emit tool calls for logging
    params.onEvent?.({
      type: "tool_calls",
      round: round + 1,
      calls: toolCalls.map((c) => {
        const args = parseToolArgs(c.arguments) as any;
        const chunkBody = typeof args.chunk_body === "string" ? args.chunk_body : "";
        const firstLine = chunkBody ? (chunkBody.split(/\r?\n/)[0] ?? "") : "";
        const lastNonEmpty = chunkBody
          ? (chunkBody.split(/\r?\n/).filter((l: string) => l.trim().length > 0).slice(-1)[0] ?? "")
          : "";
        return {
          id: c.id,
          name: c.name,
          validation_target: validationLevel === "full_validation" 
            ? (params.isFinalValidation ? "final_model" : "subassembly")
            : "partial_build",
          mode: validationLevel === "full_validation" ? "partial" : "chunk",
          step_range: params.stepFrom ? { from: params.stepFrom, to: params.stepTo } : undefined,
          ldraw_len: chunkBody.length,
          ldraw_first_line: firstLine,
          ldraw_last_line: lastNonEmpty
        };
      })
    });
    
    // Track rendered images for visual feedback
    const renderedImages: Array<{ tool_call_id: string; base64: string }> = [];
    
    const toolOutputs = toolCalls.map((c) => {
      // Accept both old and new tool names during transition
      if (c.name !== "validate_ldraw_chunk" && c.name !== "validate_ldraw_mpd") {
        return { tool_call_id: c.id, output: JSON.stringify({ ok: false, error: `Unknown tool: ${c.name}` }) };
      }
      
      const parsed = parseToolArgs(c.arguments) as any;
      const chunkBody = typeof parsed.chunk_body === "string" 
        ? parsed.chunk_body 
        : (typeof parsed.ldraw_mpd === "string" ? parsed.ldraw_mpd : ""); // Fallback for old format
      
      // SERVER-SIDE: Assemble the full MPD by combining previous chunks + new chunk
      const assembledBody = params.assembledMpdSoFar 
        ? [params.assembledMpdSoFar.trim(), chunkBody.trim()].filter(Boolean).join("\n")
        : chunkBody.trim();
      const assembledMpd = `0 FILE model.ldr\n${assembledBody}\n0 NOFILE`;
      
      // SERVER-SIDE: Determine what validation to run
      const doRenderComparison = validationLevel === "full_validation" && !!hasReferenceImage;
      const hasBlueprint = params.blueprint && params.blueprint.subassemblies && params.blueprint.subassemblies.length > 0;
      
      const validationInput: RenderValidationInput = {
        ldraw_mpd: assembledMpd,
        mode: "partial", // Always validate the assembled partial MPD
        step_from: params.stepFrom,
        step_to: params.stepTo,
        reference_image_path: doRenderComparison ? params.referenceImagePath : undefined,
        min_similarity: minSimilarity,
        do_render_comparison: doRenderComparison,
        blueprint: hasBlueprint ? params.blueprint : undefined,
        current_subassembly: params.currentSubassembly,
        // Always render for logging, even if not doing comparison
        always_render_for_logging: true,
        validation_round: round + 1
      };

      // Include rendered image for visual feedback when doing full validation
      const includeRenderedImage = shouldIncludeVisualFeedback && validationLevel === "full_validation";
      const result = validateRenderForToolLoop(validationInput, includeRenderedImage);
      
      // Always save progress image to debug log (even if not sending to GPT)
      if (result.rendered_image_base64) {
        const progressImageId = saveImageArtifact({
          tag: `validation_progress_round_${round + 1}`,
          base64: result.rendered_image_base64,
          purpose: `validation_round_${round + 1}_${validationLevel}`,
          round: round + 1,
          toolCallId: c.id
        });
        if (progressImageId) {
          logOpenAI("info", `  Progress image saved: ${progressImageId} (${validationLevel})`);
        }
      }
      
      // Store rendered image for visual feedback to GPT (if enabled)
      if (result.rendered_image_base64 && includeRenderedImage) {
        renderedImages.push({ tool_call_id: c.id, base64: result.rendered_image_base64 });
      }
      
      // Add validation level to result for logging
      const resultWithLevel = {
        ...result,
        validation_level: validationLevel,
        steps_validated: params.stepFrom && params.stepTo ? `${params.stepFrom}-${params.stepTo}` : undefined
      };
      
      // Remove rendered_image_base64 from JSON output (it's sent as input_image instead)
      const { rendered_image_base64, ...resultForJson } = resultWithLevel;
      return { tool_call_id: c.id, output: JSON.stringify(resultForJson) };
    });
    
    // Log full tool results for debugging
    const serverValidationTarget: ValidationTarget = validationLevel === "full_validation"
      ? (params.isFinalValidation ? "final_model" : "subassembly")
      : "partial_build";
    
    logOpenAI("info", `Tool results [round ${round + 1}]: ${toolOutputs.length} result(s)`);
    for (const t of toolOutputs) {
      try {
        const r = JSON.parse(t.output);
        const okStatus = r.ok ? "✓ PASSED" : "✗ FAILED";
        const similarity = r.similarity_score !== undefined ? ` (similarity: ${r.similarity_score}%)` : "";
        logOpenAI("info", `  ${t.tool_call_id}: ${okStatus}${similarity}`);
        if (!r.ok && r.error) {
          logOpenAI("info", `    Error: ${r.error}`);
        }
        if (r.issues && r.issues.length > 0) {
          for (const issue of r.issues.slice(0, 5)) {
            logOpenAI("info", `    Issue: [${issue.type}] ${issue.message}`);
          }
        }
        logOpenAI("debug", `  Full result for ${t.tool_call_id}:`, r);
      } catch {
        logOpenAI("warn", `  ${t.tool_call_id}: Failed to parse output`);
      }
    }
    
    // Write tool results artifact
    writeToolArtifact({
      tag: `tool_results_round_${round + 1}`,
      round: round + 1,
      toolResults: toolOutputs,
      note: `${toolOutputs.length} validation result(s) - validation level: ${validationLevel}`
    });
      
    params.onEvent?.({
      type: "tool_results",
      round: round + 1,
      results: toolOutputs.map((t) => {
        try {
          const r = JSON.parse(t.output) as ValidateLDrawToolResult;
          return { 
            tool_call_id: t.tool_call_id,
            validation_target: serverValidationTarget,
            ok: (r as any).ok === true, 
            error: (r as any).error,
            similarity_score: (r as any).similarity_score,
            render_compared: validationLevel === "full_validation",
            issues: (r as any).issues
          };
        } catch {
          return { 
            tool_call_id: t.tool_call_id, 
            validation_target: serverValidationTarget,
            ok: false, 
            error: "Invalid tool output JSON",
            render_compared: false
          };
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
    // Must be wrapped in a "message" with role "user" and content array
    if (renderedImages.length > 0) {
      logOpenAI("info", `Visual feedback [round ${round + 1}]: Sending ${renderedImages.length} rendered image(s) back to GPT`);
      
      // Save each rendered image for debugging
      for (const img of renderedImages) {
        const imageId = saveImageArtifact({
          tag: `visual_feedback_round_${round + 1}`,
          base64: img.base64,
          purpose: params.isFinalValidation ? "final_validation_feedback" : "subassembly_boundary_feedback",
          round: round + 1,
          toolCallId: img.tool_call_id
        });
        if (imageId) {
          logOpenAI("info", `  Saved feedback image: ${imageId}`);
        }
      }
      
      const messageContent: Array<Record<string, unknown>> = [
        {
          type: "input_text",
          text: "Here is the rendered output from your LDraw code. Compare it visually to the reference image you were given earlier and identify any discrepancies:"
        }
      ];
      
      // Add each rendered image to the message content
      for (const img of renderedImages) {
        messageContent.push({
          type: "input_image",
          image_url: `data:image/png;base64,${img.base64}`
        });
      }
      
      // Add as a user message
      inputItems.push({
        type: "message",
        role: "user",
        content: messageContent
      });
      
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
          "VALIDATION:",
          "- After generating your chunk, call validate_ldraw_chunk with your chunk_body.",
          "- The server handles everything else (combining with previous chunks, determining what to check).",
          "- If ok=false, fix your output based on the error/issues and re-validate.",
          "- Only return final JSON when ok=true.",
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
  
  // Log chunk generation request
  logOpenAI("info", `Chunk generation: steps ${stepFrom}-${stepTo}, toolLoop=${useToolLoop}, hasReference=${!!params.referenceImagePath}, assembledSoFar=${soFar.length} chars`);
  if (params.isSubassemblyBoundary) {
    logOpenAI("info", `  Subassembly boundary: ${params.currentSubassembly || "unknown"}`);
  }
  if (params.isFinalChunk) {
    logOpenAI("info", `  FINAL CHUNK`);
  }
  
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
        maxToolRounds: 25, // Allow many iterations for GPT to improve with visual feedback
        onEvent: params.onEvent,
        referenceImagePath: params.referenceImagePath,
        minSimilarity: params.minSimilarity,
        blueprint: blueprintForValidation,
        currentSubassembly: params.currentSubassembly,
        // Visual feedback settings
        visualFeedbackMode: params.visualFeedbackMode ?? "subassemblies",
        isSubassemblyBoundary: params.isSubassemblyBoundary,
        isFinalValidation: params.isFinalChunk,
        // Server-side context for assembling MPD
        assembledMpdSoFar: soFar ? soFar.replace(/^0 FILE model\.ldr\n?/, "").replace(/\n?0 NOFILE$/, "") : undefined,
        stepFrom,
        stepTo
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

/**
 * Generate a build blueprint from a user-uploaded reference image.
 * 
 * The reference image is the key input - GPT uses it to understand what to build.
 * The blueprint is then used to guide LDraw MPD chunk generation.
 * 
 * @param params.referenceImagePath - Path to user-uploaded reference image (required for best results)
 * @param params.title - Build title
 * @param params.userPrompt - Original user request/preferences
 * @param params.inventory - Available LEGO parts
 * @param params.constraintsText - Optional constraints (difficulty, age, etc.)
 */
export async function generateBlueprintForIdea(params: {
  title: string;
  userPrompt: string;
  inventory: InventoryItem[];
  constraintsText?: string;
  /** Path to user-uploaded reference image (PNG). This is the primary visual input. */
  referenceImagePath?: string;
  /** @deprecated Use referenceImagePath instead */
  previewImagePath?: string;
}): Promise<{ blueprint: LDrawBlueprint; model: string; usage?: TokenUsage }> {
  // Support both old and new parameter names during transition
  const imagePath = params.referenceImagePath || params.previewImagePath;
  const inv = inventoryToCompactJson(params.inventory);
  const constraints = params.constraintsText?.trim() ? params.constraintsText.trim() : "(none)";

  const promptText = [
    "You are an expert LEGO MOC designer and instruction planner.",
    "You will be given a user's build request and a reference image of the intended build.",
    "Produce a concise blueprint that will be used to generate an LDraw MPD with steps and instructions.",
    "",
    "Requirements:",
    "- The blueprint should reflect the reference image's silhouette and major features.",
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

  const hasReferenceImage = imagePath && fs.existsSync(imagePath);
  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: promptText }];
  if (hasReferenceImage) {
    const dataUrl = readFileAsDataUrl({ filePath: imagePath, mimeType: "image/png" });
    content.push({ type: "input_image", image_url: dataUrl });
  }

  // Log the blueprint request
  logOpenAI("info", `Blueprint generation request: title="${params.title}", hasReferenceImage=${hasReferenceImage}, inventorySize=${params.inventory.length}`);
  
  // Debug artifact: write the exact prompt + a copy of the reference image (if present) for review.
  let debugInputId: string | null = null;
  if (isDebugEnabled()) {
    try {
      const dir = getDebugDir();
      const id = generateArtifactId("blueprint_input");
      debugInputId = id;
      let copiedImageRelPath: string | null = null;
      if (hasReferenceImage) {
        const outImg = path.join(dir, `${id}.png`);
        fs.copyFileSync(imagePath, outImg);
        copiedImageRelPath = path.relative(process.cwd(), outImg);
        logOpenAI("info", `Blueprint reference image saved: ${outImg}`);
      }
      const outJson = path.join(dir, `${id}.json`);
      const payload = {
        id,
        tag: "blueprint_input",
        at: new Date().toISOString(),
        note: "Blueprint vision call input (prompt + reference image copy).",
        promptText,
        referenceImageOriginalPath: imagePath || null,
        referenceImageCopiedPath: copiedImageRelPath,
        inventorySize: params.inventory.length,
        constraints: params.constraintsText,
        // Include the exact message array we send (without duplicating the full prompt text and
        // without embedding the data-url image to keep file size sane)
        requestShape: {
          role: "user",
          content: [
            { type: "input_text", text: "(see promptText field)" },
            hasReferenceImage
              ? { type: "input_image", image_url: "(data-url omitted; see copied PNG path)" }
              : null
          ].filter(Boolean)
        }
      };
      fs.writeFileSync(outJson, JSON.stringify(payload, null, 2), "utf8");
      logOpenAI("info", `Blueprint input artifact: ${outJson}`);
    } catch (e) {
      logOpenAI("warn", `Failed to write blueprint input artifact: ${e instanceof Error ? e.message : "unknown"}`);
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
  logOpenAI("info", `Blueprint API call starting: schema=lego_ldraw_blueprint, reasoning=${reasoningEffort}, maxTokens=${maxOutputTokens}`);
  
  const resp = await callOpenAIJsonInput<LDrawBlueprint>(
    { input: [{ role: "user", content }], schemaName: "lego_ldraw_blueprint", schema },
    { reasoningEffort, maxOutputTokens: Math.floor(maxOutputTokens) }
  );
  const durationMs = Date.now() - startedAtMs;
  const rawResponse = resp.rawResponseJson as Record<string, unknown>;
  const rawUsage = (rawResponse as any)?.usage;
  
  logOpenAI("info", `Blueprint API response: model=${resp.model}, duration=${durationMs}ms, tokens=${rawUsage?.total_tokens || "?"}`);
  logOpenAI("info", `Blueprint result: ${resp.parsed?.step_outline?.length || 0} steps, ${resp.parsed?.structure_plan?.subassemblies?.length || 0} subassemblies`);

  if (isDebugEnabled()) {
    try {
      const dir = getDebugDir();
      const id = generateArtifactId("blueprint_response");
      const outJson = path.join(dir, `${id}.json`);
      const payload = {
        id,
        tag: "blueprint_response",
        at: new Date().toISOString(),
        debugInputId,
        durationMs,
        model: resp.model,
        responseId: (rawResponse as any)?.id ?? null,
        status: (rawResponse as any)?.status ?? null,
        usage: rawUsage ?? null,
        // Include the full blueprint result
        blueprintResult: resp.parsed,
        extractedText: resp.extractedText?.slice(0, 5000) // Truncate if very long
      };
      fs.writeFileSync(outJson, JSON.stringify(payload, null, 2), "utf8");
      logOpenAI("info", `Blueprint response artifact: ${outJson}`);
    } catch (e) {
      logOpenAI("warn", `Failed to write blueprint response artifact: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  const usage: TokenUsage | undefined = rawUsage ? {
    input_tokens: rawUsage?.input_tokens || 0,
    output_tokens: rawUsage?.output_tokens || 0,
    reasoning_tokens: rawUsage?.output_tokens_details?.reasoning_tokens,
    total_tokens: rawUsage?.total_tokens || 0
  } : undefined;
  
  return { blueprint: resp.parsed as LDrawBlueprint, model: resp.model, usage };
}


