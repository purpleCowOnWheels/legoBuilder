import { InventoryItem, type IdeaCandidate as IdeaCandidateModel } from "@/lib/models";
import { validateLDrawMpdOrThrow } from "@/lib/ldrawValidate";
import { validateLDrawMpdChunkBodyOrThrow, validateLDrawPartialMpdOrThrow } from "@/lib/ldrawValidate";
import { validateRenderForToolLoop, type RenderValidationInput, type BlueprintInfo, type ToolLoopValidationResult } from "@/lib/renderValidation";
import { TokenTracker, calculateCost, formatUsageEntry, type TokenUsage } from "@/lib/tokenUsage";
import fs from "node:fs";
import path from "node:path";

// =============================================================================
// Run-specific logging directory management
// =============================================================================
// When a pipeline run starts, it should call setRunLogDir() to direct all debug
// artifacts to its run-specific folder instead of the global openai-debug folder.

let _currentRunLogDir: string | null = null;

/**
 * Set the log directory for the current run.
 * All debug artifacts will be written to subdirectories of this path.
 * Call with null to reset to default (data/openai-debug).
 */
export function setRunLogDir(logDir: string | null) {
  _currentRunLogDir = logDir;
  if (logDir) {
    // Create standard subdirectories
    fs.mkdirSync(path.join(logDir, "api_calls"), { recursive: true });
    fs.mkdirSync(path.join(logDir, "renders"), { recursive: true });
    
    // Initialize pipeline.log
    const pipelineLog = path.join(logDir, "pipeline.log");
    fs.writeFileSync(pipelineLog, `=== LEGO Build Pipeline ===\nStarted: ${new Date().toISOString()}\n`);
  }
}

/**
 * Get the current run's log directory, or null if not set.
 */
export function getRunLogDir(): string | null {
  return _currentRunLogDir;
}

// =============================================================================
// Simple status logger for human-readable progress
// =============================================================================

let _currentSubassemblyLog: string | null = null;

function setCurrentSubassemblyLog(logPath: string | null) {
  _currentSubassemblyLog = logPath;
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19); // HH:MM:SS
}

function status(message: string, indent = 0) {
  const prefix = "  ".repeat(indent);
  const line = `${prefix}${message}`;
  console.log(line);
  
  // Write to subassembly log if active
  if (_currentSubassemblyLog && _currentRunLogDir) {
    const logLine = `[${timestamp()}] ${line}\n`;
    fs.appendFileSync(_currentSubassemblyLog, logLine);
  }
}

function statusHeader(step: number, title: string) {
  const line1 = `\n${"─".repeat(50)}`;
  const line2 = `Step ${step}: ${title}`;
  const line3 = "─".repeat(50);
  console.log(line1);
  console.log(line2);
  console.log(line3);
  
  // Write to pipeline log
  if (_currentRunLogDir) {
    const pipelineLog = path.join(_currentRunLogDir, "pipeline.log");
    fs.appendFileSync(pipelineLog, `\n[${timestamp()}] === Step ${step}: ${title} ===\n`);
  }
}

function statusResult(label: string, success: boolean, detail?: string) {
  const icon = success ? "✓" : "✗";
  const suffix = detail ? ` (${detail})` : "";
  const line = `  ${icon} ${label}${suffix}`;
  console.log(line);
  
  // Write to subassembly log if active
  if (_currentSubassemblyLog && _currentRunLogDir) {
    fs.appendFileSync(_currentSubassemblyLog, `[${timestamp()}] ${line}\n`);
  }
}

/**
 * Create a clean folder name from a subassembly name.
 * - Lowercase
 * - Replace non-alphanumeric with underscores
 * - Collapse multiple underscores
 * - Trim leading/trailing underscores
 */
function toFolderName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')  // Replace non-alphanumeric sequences with single underscore
    .replace(/^_|_$/g, '');        // Trim leading/trailing underscores
}

/**
 * Write to subassembly log file only (no console output).
 * Used for detailed progress during parallel builds.
 */
function logToFile(message: string) {
  if (_currentSubassemblyLog) {
    fs.appendFileSync(_currentSubassemblyLog, `[${timestamp()}] ${message}\n`);
  }
}

function pipelineStatus(subassemblyName: string, stage: string) {
  // Write high-level status to pipeline.log
  if (_currentRunLogDir) {
    const pipelineLog = path.join(_currentRunLogDir, "pipeline.log");
    fs.appendFileSync(pipelineLog, `[${timestamp()}] ${subassemblyName}: ${stage}\n`);
  }
}

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
        /** Path to the rendered validation image (for logging/copying) */
        rendered_image_path?: string;
        /** Number of pieces added in this chunk */
        pieces_in_chunk?: number;
        /** Total pieces accumulated so far */
        pieces_total?: number;
      }>;
    }
  | { type: "round_done"; round: number }
  | { 
      type: "visual_feedback_sent"; 
      round: number; 
      image_count: number;
      /** Paths to the rendered images being sent */
      image_paths?: string[];
      /** Describes when visual feedback was triggered */
      trigger: "subassembly_boundary" | "final_validation";
    };

/**
 * Parse SSE (Server-Sent Events) stream from OpenAI streaming response.
 * Accumulates events and returns the final response from the "response.completed" event.
 */
async function parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onProgress?: (event: { type: string; data?: unknown }) => void
): Promise<OpenAIResponse> {
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResponse: OpenAIResponse | null = null;
  const eventTypes = new Set<string>();
  let eventCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    
    // Keep the last incomplete line in the buffer
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) continue; // Skip empty lines and comments
      
      if (trimmed === "data: [DONE]") {
        continue; // End of stream marker
      }

      if (trimmed.startsWith("data: ")) {
        try {
          const jsonStr = trimmed.slice(6); // Remove "data: " prefix
          const event = JSON.parse(jsonStr);
          eventCount++;
          
          // Track event types for debugging
          if (event.type) {
            eventTypes.add(event.type);
          }
          
          // Report progress for certain event types
          if (onProgress) {
            onProgress({ type: event.type, data: event });
          }

          // The "response.completed" event signals successful completion
          // The response data may be in event.response or at the event root level
          if (event.type === "response.completed") {
            if (event.response) {
              finalResponse = event.response as OpenAIResponse;
            } else if (event.id && event.output) {
              // Response data is at the root level of the event
              finalResponse = event as OpenAIResponse;
            }
          }
          
          // Also check for "response.done" (legacy/alternative event name)
          if (event.type === "response.done") {
            if (event.response) {
              finalResponse = event.response as OpenAIResponse;
            } else if (event.id && event.output) {
              finalResponse = event as OpenAIResponse;
            }
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    }
  }

  if (!finalResponse) {
    // Log what we did receive for debugging
    logOpenAI("warn", `Stream ended without final response. Received ${eventCount} events. Types: ${Array.from(eventTypes).join(", ") || "none"}`);
    throw new Error("Stream ended without receiving response.completed event");
  }

  return finalResponse;
}

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
  const toolCount = params.body.tools ? (params.body.tools as unknown[]).length : 0;
  const imageInfo = summary.imageCount > 0 ? `, ${summary.imageCount} image(s)` : "";
  const toolInfo = toolCount > 0 ? `, ${toolCount} tool(s)` : "";
  logOpenAI("info", `  [Round ${params.roundForLogging}] Calling ${params.body.model}${imageInfo}${toolInfo}...`);
  
  // Use streaming to prevent network-level timeouts on long requests
  const useStreaming = true;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startMs = Date.now();
    try {
      // Hard timeout so a single OpenAI request can't hang indefinitely.
      // Extended reasoning + tool loops + visual feedback can take longer.
      // Use environment variable or default based on context.
      const defaultTimeout = 900_000; // 15 minutes default for reasoning models with complex tasks
      const timeoutMs = process.env.OPENAI_TIMEOUT_MS 
        ? parseInt(process.env.OPENAI_TIMEOUT_MS, 10) 
        : defaultTimeout;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      // Add stream: true to the request body
      const requestBody = useStreaming 
        ? { ...params.body, stream: true }
        : params.body;

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      if (!res.ok) {
        clearTimeout(timeout);
        const rawText = await res.text();
        const durationMs = Date.now() - startMs;
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

      let responseJson: OpenAIResponse;
      
      if (useStreaming && res.body) {
        // Parse streaming response
        const reader = res.body.getReader();
        let lastProgressLog = Date.now();
        
        responseJson = await parseSSEStream(reader, (event) => {
          // Log progress every 30 seconds to show the connection is alive
          const now = Date.now();
          if (now - lastProgressLog > 30000) {
            const elapsedSec = ((now - startMs) / 1000).toFixed(0);
            logOpenAI("info", `  [Round ${params.roundForLogging}] Still processing... (${elapsedSec}s)`);
            lastProgressLog = now;
          }
        });
      } else {
        // Non-streaming fallback
        const rawText = await res.text();
        responseJson = JSON.parse(rawText) as OpenAIResponse;
      }
      
      clearTimeout(timeout);
      const durationMs = Date.now() - startMs;
      const usage = (responseJson as any).usage;
      
      // Log the response
      const durationSec = (durationMs / 1000).toFixed(1);
      logOpenAI("info", `  [Round ${params.roundForLogging}] Response received (${durationSec}s, ${usage?.total_tokens || "?"} tokens)`);
      
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
  if (level === "error") {
    // eslint-disable-next-line no-console
    console.error(message, data ? JSON.stringify(data, null, 2).slice(0, 2000) : "");
  } else if (level === "warn") {
    // eslint-disable-next-line no-console
    console.warn(message, data ? JSON.stringify(data, null, 2).slice(0, 1000) : "");
  } else if (level === "debug" && isDebugEnabled()) {
    // eslint-disable-next-line no-console
    console.log(`[debug] ${message}`, data ? JSON.stringify(data, null, 2).slice(0, 2000) : "");
  } else if (level === "info") {
    // eslint-disable-next-line no-console
    console.log(message);
  }
}

function getDebugDir(subdir?: "api_calls" | "renders") {
  // Use run-specific directory if set, otherwise fall back to global openai-debug
  const baseDir = _currentRunLogDir || path.join(process.cwd(), "data", "openai-debug");
  const dir = subdir ? path.join(baseDir, subdir) : baseDir;
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

  const dir = getDebugDir("api_calls");
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
  logOpenAI("debug", `Debug artifact written: ${filePath}`);
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

  const dir = getDebugDir("api_calls");
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
  logOpenAI("debug", `API call artifact: ${filePath}`);
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

  const dir = getDebugDir("renders");
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

  logOpenAI("debug", `Image artifact saved: ${imagePath} (${buffer.length} bytes, purpose: ${params.purpose})`);
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

  const dir = getDebugDir("api_calls");
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
  logOpenAI("info", `Requesting ${params.schemaName}...`);

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
    logOpenAI("info", `✓ ${params.schemaName} received`);
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
  const imageNote = inputSummary.imageCount > 0 ? ` with ${inputSummary.imageCount} image(s)` : "";
  logOpenAI("info", `Requesting ${params.schemaName}${imageNote}...`);

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
    logOpenAI("info", `✓ ${params.schemaName} received`);
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
    "- Run continuity checks (alignment, isolated parts)",
    "- Render the current build and return the image"
  ];
  
  if (params.isFinalValidation) {
    descriptionParts.push("- Compare rendered image to reference (similarity scoring)");
    descriptionParts.push("");
    descriptionParts.push("This is the FINAL validation - similarity score must pass threshold.");
    descriptionParts.push("");
    descriptionParts.push("IMPORTANT: When you receive the rendered image, carefully check for:");
    descriptionParts.push("1. Discontinuities/floating parts (all pieces must connect)");
    descriptionParts.push("2. Gaps or holes in surfaces that should be solid");
    descriptionParts.push("3. Missing key features from the reference");
    descriptionParts.push("4. Wrong proportions or orientations");
    descriptionParts.push("5. Structural stability issues");
    descriptionParts.push("6. Major deviations from the description");
  } else if (shouldIncludeVisualFeedback) {
    descriptionParts.push("");
    descriptionParts.push("You will receive a rendered image of your subassembly.");
    descriptionParts.push("");
    descriptionParts.push("COMPARE TO REFERENCE: Look at the INPUT/REFERENCE IMAGE and find the sub-region that corresponds to this subassembly. Your render should match that sub-region's shape and structure.");
    descriptionParts.push("");
    descriptionParts.push("CHECK FOR ISSUES:");
    descriptionParts.push("1. DISCONTINUITIES: Floating/disconnected parts (critical - fix immediately)");
    descriptionParts.push("2. GAPS: Unintentional holes where surfaces should be solid");
    descriptionParts.push("3. MISSING FEATURES: Key visual elements from that sub-region not present");
    descriptionParts.push("4. PROPORTIONS: Shape doesn't match the sub-region (too wide, tall, thin, etc.)");
    descriptionParts.push("5. ORIENTATION: Parts facing wrong direction vs reference");
    descriptionParts.push("6. STRUCTURAL ISSUES: Parts that wouldn't stay connected in real LEGO");
    descriptionParts.push("");
    descriptionParts.push("If ANY issue is found, fix it and re-validate. Focus especially on discontinuities.");
  }
  
  descriptionParts.push("");
  descriptionParts.push("Returns ok=true if structure is valid. For subassemblies, YOU decide if the visual matches.");

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
    logOpenAI("info", `  [Round ${round + 1}] Validating ${toolCalls.length} chunk(s)...`);
    for (const c of toolCalls) {
      const args = parseToolArgs(c.arguments) as any;
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
    const renderedImages: Array<{ tool_call_id: string; base64: string; savedPath?: string }> = [];
    
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
      
      // Don't wrap if the content already has FILE declarations (multi-file MPD)
      const hasFileDeclarations = /^0\s+FILE\s+/m.test(assembledBody);
      const assembledMpd = hasFileDeclarations
        ? assembledBody  // Already structured, don't wrap
        : `0 FILE model.ldr\n${assembledBody}\n0 NOFILE`;  // Simple chunk needs wrapper
      
      // Count pieces in this chunk and total accumulated
      const countPiecesInMpd = (mpd: string): number => {
        const lines = mpd.split("\n");
        return lines.filter(line => {
          const trimmed = line.trim();
          return trimmed.startsWith("1 ") && !trimmed.includes("0 FILE") && !trimmed.includes("0 NOFILE");
        }).length;
      };
      
      // For piece counting, handle both wrapped and unwrapped formats
      const chunkHasFileDeclarations = /^0\s+FILE\s+/m.test(chunkBody.trim());
      const chunkMpd = chunkHasFileDeclarations
        ? chunkBody.trim()
        : `0 FILE model.ldr\n${chunkBody.trim()}\n0 NOFILE`;
      const piecesInChunk = countPiecesInMpd(chunkMpd);
      const piecesInTotal = countPiecesInMpd(assembledMpd);
      
      // Log piece counts
      // eslint-disable-next-line no-console
      console.log(`[Validation Round ${round + 1}] Pieces: +${piecesInChunk} (${piecesInTotal} total)`);
      
      // SERVER-SIDE: Determine what to validate
      // For subassembly boundaries, only validate the CURRENT chunk (not accumulated build)
      // For final validation, validate the complete assembled model
      const mpdToValidate = params.isSubassemblyBoundary && !params.isFinalValidation
        ? chunkMpd  // Just the current chunk
        : assembledMpd;  // Full accumulated build for final validation
      
      // SERVER-SIDE: Determine what validation to run
      // Only do similarity comparison for FINAL validation - subassemblies just render for visual feedback
      // GPT can see the render and decide if it looks right (semantic validation vs pixel comparison)
      const doRenderComparison = params.isFinalValidation && !!hasReferenceImage;
      const hasBlueprint = params.blueprint && params.blueprint.subassemblies && params.blueprint.subassemblies.length > 0;
      
      const validationInput: RenderValidationInput = {
        ldraw_mpd: mpdToValidate,
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
      
      // Track the image path for copying to pipeline output
      let progressImagePath: string | undefined;
      
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
          logOpenAI("debug", `  Progress image saved: ${progressImageId} (${validationLevel})`);
          // Build full path to the saved image
          const debugDir = getDebugDir("renders");
          progressImagePath = path.join(debugDir, `${progressImageId}.png`);
        }
      }
      
      // Store rendered image for visual feedback to GPT (if enabled)
      if (result.rendered_image_base64 && includeRenderedImage) {
        // Save image for visual feedback
        const feedbackImagePath = saveImageArtifact({
          tag: `visual_feedback_round_${round + 1}`,
          base64: result.rendered_image_base64,
          purpose: params.isFinalValidation ? "final_validation_feedback" : "subassembly_feedback",
          round: round + 1,
          toolCallId: c.id
        });
        
        renderedImages.push({ 
          tool_call_id: c.id, 
          base64: result.rendered_image_base64,
          savedPath: feedbackImagePath || undefined
        });
      }
      
      // Add validation level and image path to result for logging
      const resultWithLevel = {
        ...result,
        validation_level: validationLevel,
        steps_validated: params.stepFrom && params.stepTo ? `${params.stepFrom}-${params.stepTo}` : undefined,
        rendered_image_path: progressImagePath,
        pieces_in_chunk: piecesInChunk,
        pieces_total: piecesInTotal
      };
      
      // Remove rendered_image_base64 from JSON output (it's sent as input_image instead)
      const { rendered_image_base64, ...resultForJson } = resultWithLevel;
      return { tool_call_id: c.id, output: JSON.stringify(resultForJson), progressImagePath };
    });
    
    // Log full tool results for debugging
    const serverValidationTarget: ValidationTarget = validationLevel === "full_validation"
      ? (params.isFinalValidation ? "final_model" : "subassembly")
      : "partial_build";
    
    for (const t of toolOutputs) {
      try {
        const r = JSON.parse(t.output);
        const okStatus = r.ok ? "✓ Validation passed" : "✗ Validation failed";
        const similarity = r.similarity_score !== undefined ? ` (${r.similarity_score}% similarity)` : "";
        logOpenAI("info", `  [Round ${round + 1}] ${okStatus}${similarity}`);
        if (!r.ok && r.error) {
          logOpenAI("info", `    Error: ${r.error}`);
        }
        if (r.issues && r.issues.length > 0) {
          for (const issue of r.issues.slice(0, 5)) {
            logOpenAI("info", `    Issue: [${issue.type}] ${issue.message}`);
          }
        }
        logOpenAI("debug", `  Full result for ${t.tool_call_id}:`, r);
        
        // CRITICAL: 0% similarity indicates broken render - fail fast
        if (r.similarity_score === 0 && validationLevel === "full_validation") {
          logOpenAI("error", `FATAL: 0% similarity detected - render is likely broken (empty/transparent image)`);
          logOpenAI("error", `This usually means LDraw file references have issues (spaces in names, missing files, etc.)`);
          throw new Error("Render failure: 0% similarity indicates broken render output. Check LDraw file references.");
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("0% similarity")) {
          throw e; // Re-throw our intentional error
        }
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
            issues: (r as any).issues,
            rendered_image_path: (r as any).rendered_image_path,
            pieces_in_chunk: (r as any).pieces_in_chunk,
            pieces_total: (r as any).pieces_total
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
      logOpenAI("info", `  [Round ${round + 1}] Sending render back to GPT for review...`);
      
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
          logOpenAI("debug", `  Saved feedback image: ${imageId}`);
        }
      }
      
      const messageContent: Array<Record<string, unknown>> = [];
      
      // Build context-aware feedback message
      const subassemblyName = params.currentSubassembly || "current section";
      let feedbackText: string;
      
      // Build the visual validation checklist that applies to all renderings
      const visualChecklistItems = [
        "DISCONTINUITIES: Are there floating/disconnected parts? All pieces must connect to the main structure.",
        "GAPS & HOLES: Are there unintentional gaps where surfaces should be solid or continuous?",
        "MISSING FEATURES: Are key visual features from the reference/description present?",
        "PROPORTIONS: Is the overall shape correctly proportioned (not too wide, tall, thin, etc.)?",
        "ORIENTATION: Are parts facing the correct direction? Check for backwards or upside-down pieces.",
        "SYMMETRY: If the build should be symmetric, is it balanced on both sides?",
        "STRUCTURAL STABILITY: Would this build stay together? Are connections secure?",
        "MAJOR DEVIATIONS: Does the build fundamentally differ from what was described/shown?"
      ];
      
      const checklistFormatted = visualChecklistItems.map((item, i) => `${i + 1}. ${item}`).join("\n");
      
      if (params.isFinalValidation) {
        // Final validation - we have similarity scoring
        const targetScore = minSimilarity;
        let currentScore: number | undefined;
        try {
          if (toolOutputs.length > 0) {
            const result = JSON.parse(toolOutputs[0].output);
            currentScore = result.similarity_score;
          }
        } catch {
          // Ignore parse errors
        }
        
        const scoreInfo = currentScore !== undefined 
          ? `Current similarity: ${currentScore}% (need ${targetScore}% to pass)`
          : `Target similarity: ${targetScore}%`;
        
        feedbackText = `Here is the rendered output of your complete build. ${scoreInfo}.

VISUAL VALIDATION CHECKLIST - Check each item carefully:
${checklistFormatted}

Compare this render against the reference image. If ANY checklist item fails, fix the issues and re-validate. Pay special attention to discontinuities and floating parts - these indicate structural problems.`;
      } else {
        // Subassembly - no similarity scoring, GPT judges visually
        feedbackText = `Here is your rendered "${subassemblyName}" subassembly.

COMPARE TO REFERENCE: Find the ${subassemblyName.toUpperCase()} sub-region in the reference image. Your render should match that sub-region's shape, structure, and proportions. Colors are secondary.

VISUAL VALIDATION CHECKLIST - Check each item carefully:
${checklistFormatted}

If ANY checklist item fails (especially DISCONTINUITIES or MISSING FEATURES), revise your LDraw and re-validate. If it looks correct, you can proceed.`;
      }
      
      messageContent.push({
        type: "input_text",
        text: feedbackText
      });
      
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
        image_paths: renderedImages.map(img => img.savedPath).filter((p): p is string => !!p),
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
  /** Current chunk number (1-based) for piece budget calculation */
  currentChunkNumber?: number;
  /** Total number of chunks for piece budget calculation */
  totalChunks?: number;
  /** Skip validation that requires part lines (for assembly refinement that only adjusts coordinates) */
  skipPartValidation?: boolean;
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

  // Calculate piece budget for this chunk
  const totalChunks = params.totalChunks || 1;
  const currentChunk = params.currentChunkNumber || 1;
  const targetPiecesMin = 25;
  const targetPiecesMax = 500;
  
  // Target 25-50 pieces per chunk (with 5 parts/step max, 8 steps/chunk allows ~40 pieces)
  const minPiecesThisChunk = 25;
  const maxPiecesThisChunk = 50;
  const avgPiecesPerChunk = Math.floor((minPiecesThisChunk + maxPiecesThisChunk) / 2);
  
  // Provide guidance that accounts for total budget and current progress
  const totalBudget = (targetPiecesMin + targetPiecesMax) / 2; // ~262 pieces avg
  const budgetRemaining = Math.max(0, totalBudget - (avgPiecesPerChunk * (currentChunk - 1)));
  const chunksRemaining = Math.max(1, totalChunks - currentChunk + 1);
  const recommendedThisChunk = Math.min(maxPiecesThisChunk, Math.ceil(budgetRemaining / chunksRemaining));
  
  const pieceBudgetGuidance = `For this chunk (${currentChunk}/${totalChunks}), aim for ${recommendedThisChunk} pieces (range: ${minPiecesThisChunk}-${maxPiecesThisChunk} acceptable). Total budget: ${Math.floor(targetPiecesMin)}-${Math.floor(targetPiecesMax)} pieces for complete model.`;

  const prompt = [
    "You are an expert LEGO MOC designer and LDraw author.",
    "We are generating the final build MPD in CHUNKS to avoid truncation.",
    "You must output ONLY the LDraw BODY for the requested step range (no MPD wrapper).",
    "",
    "BUILD CONSTRAINTS:",
    "- Use between 25 and 500 LEGO pieces total for the COMPLETE model",
    `- ${pieceBudgetGuidance}`,
    "- Each step should add NO MORE THAN 5 parts (keep instructions manageable)",
    "- Focus on capturing the key recognizable features rather than every detail",
    "- Prioritize structural stability and realistic proportions within the piece budget",
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
          "- You will receive a RENDERED IMAGE of your build. CAREFULLY INSPECT IT for:",
          "  1. DISCONTINUITIES: Floating/disconnected parts (CRITICAL - all pieces must connect)",
          "  2. GAPS: Holes where surfaces should be solid",
          "  3. MISSING FEATURES: Key elements from the description not present",
          "  4. PROPORTIONS: Shape doesn't match reference (too wide, tall, etc.)",
          "  5. ORIENTATION: Parts facing wrong direction",
          "  6. STRUCTURAL ISSUES: Parts that would fall off",
          "  7. MAJOR DEVIATIONS: Build doesn't match what was described",
          "- If ok=false OR the render shows ANY of the above issues, fix your LDraw and re-validate.",
          "- Only return final JSON when ok=true AND the render looks correct.",
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
  const chunkInfo = params.isFinalChunk ? " (final)" : "";
  const subassemblyInfo = params.isSubassemblyBoundary ? ` [${params.currentSubassembly || "subassembly"}]` : "";
  logOpenAI("info", `Generating steps ${stepFrom}-${stepTo}${subassemblyInfo}${chunkInfo}`);
  
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

  // Server-side validation (can be skipped for assembly refinement):
  if (!params.skipPartValidation) {
    validateLDrawMpdChunkBodyOrThrow({ chunkBody, stepFrom, stepTo });
    // Also validate assembled MPD so far (including this chunk) as a partial MPD.
    const assembledParts = [soFar, chunkBody].filter(Boolean).join("\n").trim();
    const assembledCandidate = ["0 FILE model.ldr", assembledParts, "0 NOFILE"].join("\n");
    validateLDrawPartialMpdOrThrow(assembledCandidate);
  }

  return { chunkBody: chunkBody.trim() + "\n", model: resp.model };
}

/**
 * Analyze an image to extract a title and detailed build description.
 * This helps the model understand what to build without copyright issues.
 * 
 * @param imagePath - Path to the reference image
 * @returns Title and detailed description of what to build
 */
export async function analyzeImageForBuild(params: { 
  imagePath: string;
}): Promise<{ title: string; description: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const model = process.env.OPENAI_MODEL;
  if (!model) throw new Error("OPENAI_MODEL is not set");

  if (!fs.existsSync(params.imagePath)) {
    throw new Error(`Image not found: ${params.imagePath}`);
  }

  const dataUrl = readFileAsDataUrl({ filePath: params.imagePath, mimeType: "image/png" });
  
  const prompt = [
    "Analyze this image and provide:",
    "1. A short title (2-8 words) describing what you see",
    "2. A detailed description of the physical features to replicate in LEGO",
    "",
    "IMPORTANT:",
    "- Focus on visual features: colors, shapes, proportions, distinctive elements",
    "- Avoid copyrighted character names or franchise-specific terms",
    "- Use generic descriptive terms (e.g., 'person in white robes with blue weapon' instead of specific character names)",
    "- Describe what you see objectively as if explaining to someone who will build it",
    "",
    "Example output format:",
    '{',
    '  "title": "Person in White Robes",',
    '  "description": "A humanoid figure wearing flowing white robes with a tan belt. The figure has blonde hair and holds a glowing blue cylindrical weapon. The robes have black trim details and the legs have tan wrappings. The overall color scheme is white, tan, and blue."',
    '}'
  ].join("\n");

  const content = [
    { type: "input_text", text: prompt },
    { type: "input_image", image_url: dataUrl }
  ];

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["title", "description"],
    properties: {
      title: { type: "string", minLength: 3, maxLength: 100 },
      description: { type: "string", minLength: 50, maxLength: 1000 }
    }
  } as const;

  logOpenAI("info", "Analyzing image...");

  const resp = await callOpenAIJsonInput<{ title: string; description: string }>(
    { input: [{ role: "user", content }], schemaName: "lego_build_analysis", schema },
    { reasoningEffort: "medium", maxOutputTokens: 500 }
  );

  logOpenAI("info", `✓ Image analyzed: "${resp.parsed?.title}"`);

  return resp.parsed as { title: string; description: string };
}

/**
 * Extract a descriptive title from an image of a LEGO build.
 * This uses vision to identify what's in the image, without text prompt influence.
 * 
 * @deprecated Use analyzeImageForBuild instead for better results
 * @param imagePath - Path to the reference image
 * @returns A short, descriptive title (2-8 words) based on what's visible in the image
 */
export async function extractTitleFromImage(params: { 
  imagePath: string;
}): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return "LEGO Build";
  const model = process.env.OPENAI_MODEL;
  if (!model) return "LEGO Build";

  if (!fs.existsSync(params.imagePath)) {
    throw new Error(`Image not found: ${params.imagePath}`);
  }

  const dataUrl = readFileAsDataUrl({ filePath: params.imagePath, mimeType: "image/png" });
  
  const prompt = [
    "Look at this image and identify what LEGO model or object is shown.",
    "Return ONLY a short, descriptive title (2-8 words) that describes what you see.",
    "Examples:",
    "- 'Luke Skywalker Minifigure'",
    "- 'Red Sports Car'",
    "- 'Medieval Castle'",
    "- 'Blue Spaceship'",
    "",
    "Do NOT include quotes, punctuation, or explanations. Just the title."
  ].join("\n");

  const content = [
    { type: "input_text", text: prompt },
    { type: "input_image", image_url: dataUrl }
  ];

  try {
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        input: [{ role: "user", content }],
        max_output_tokens: 50
      })
    });

    if (!resp.ok) {
      return "LEGO Build";
    }

    const json = (await resp.json()) as OpenAIResponse;
    const text = extractTextFromResponses(json);
    const cleaned = text.trim().replace(/^["']|["']$/g, "");
    return cleaned || "LEGO Build";
  } catch {
    return "LEGO Build";
  }
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
  step_outline: Array<{ 
    step: number; 
    title: string; 
    description: string;
    /** Which subassembly this step belongs to (must match one of structure_plan.subassemblies[].name) */
    subassembly_name: string;
  }>;
  notes: string[];
};

/**
 * Phase 1: High-level structure plan only (no detailed steps yet)
 */
export type LDrawStructurePlan = {
  overview: string;
  subassemblies: Array<{ 
    name: string; 
    description: string;
    /** Visual location hint for where this subassembly appears in the reference image */
    image_location: string;
  }>;
  estimated_total_pieces: number;
  notes: string[];
};

/**
 * Phase 2a: Detailed step plan for a single subassembly
 */
export type SubassemblyStepPlan = {
  subassembly_name: string;
  /** Visual description of where this subassembly is located in the reference image */
  image_location_description: string;
  steps: Array<{
    step: number;
    title: string;
    description: string;
  }>;
  estimated_pieces: number;
};

/**
 * Phase 2b: Generated LDraw MPD for a single subassembly
 */
export type SubassemblyBuildResult = {
  subassembly_name: string;
  ldraw_mpd: string;
  actual_pieces: number;
  validation_rounds: number;
  final_similarity_score?: number;
};

/**
 * PHASE 1: Generate high-level structure plan with subassemblies only (no detailed steps)
 * This is fast and gives us the overall structure to parallelize the rest.
 */
export async function generateStructurePlan(params: {
  referenceImagePath: string;
  inventory: InventoryItem[];
  constraintsText?: string;
  logDir?: string;
}): Promise<{ plan: LDrawStructurePlan; model: string }> {
  if (!fs.existsSync(params.referenceImagePath)) {
    throw new Error("Reference image is required for structure plan generation");
  }

  const logDir = params.logDir ? `${params.logDir}/01_structure_plan` : null;
  if (logDir) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const inv = inventoryToCompactJson(params.inventory);
  const constraints = params.constraintsText?.trim() || "Build something interesting with the available parts.";

  const promptText = [
    "You are an expert LEGO MOC designer.",
    "",
    "TASK: Look at the reference image and create a HIGH-LEVEL structure plan.",
    "",
    "Requirements:",
    "- Identify the major subassemblies (legs, torso, head, accessories, etc.)",
    "- For each subassembly, note WHERE in the image it appears",
    "- Estimate total piece count (25-500 pieces total)",
    "- Keep it simple and buildable",
    "",
    "DO NOT generate detailed steps yet - just the overall structure.",
    "",
    "Constraints:",
    constraints,
    "",
    "Available parts (JSON map of partNum -> color -> qty):",
    inv
  ].join("\n");

  const dataUrl = readFileAsDataUrl({ filePath: params.referenceImagePath, mimeType: "image/png" });
  const content: Array<Record<string, unknown>> = [
    { type: "input_text", text: promptText },
    { type: "input_image", image_url: dataUrl }
  ];

  // Log to debug files only
  logOpenAI("info", "Generating structure plan...");
  if (logDir) {
    fs.writeFileSync(`${logDir}/input.txt`, promptText, "utf8");
    fs.copyFileSync(params.referenceImagePath, `${logDir}/reference.png`);
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["overview", "subassemblies", "estimated_total_pieces", "notes"],
    properties: {
      overview: { type: "string" },
      subassemblies: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "description", "image_location"],
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            image_location: { type: "string" }
          }
        }
      },
      estimated_total_pieces: { type: "integer", minimum: 25, maximum: 500 },
      notes: { type: "array", items: { type: "string" } }
    }
  } as const;

  const resp = await callOpenAIJsonInput<LDrawStructurePlan>(
    { input: [{ role: "user", content }], schemaName: "lego_structure_plan", schema },
    { reasoningEffort: "low", maxOutputTokens: 5000 }
  );

  // Log to debug files only
  logOpenAI("info", `✓ Structure plan: ${resp.parsed?.subassemblies?.length || 0} subassemblies, ~${resp.parsed?.estimated_total_pieces || "?"} pieces`);

  if (logDir && resp.parsed) {
    fs.writeFileSync(`${logDir}/output.json`, JSON.stringify(resp.parsed, null, 2), "utf8");
  }

  return { plan: resp.parsed!, model: resp.model };
}

/**
 * PHASE 2a: Generate detailed step plan for a single subassembly
 */
export async function generateSubassemblyStepPlan(params: {
  subassemblyName: string;
  subassemblyDescription: string;
  imageLocation?: string;
  referenceImagePath: string;
  inventory: InventoryItem[];
  targetPieceCount: number;
  logDir?: string;
}): Promise<{ plan: SubassemblyStepPlan; model: string }> {
  const safeName = toFolderName(params.subassemblyName);
  const subassemblyDir = params.logDir ? `${params.logDir}/subassemblies/${safeName}` : null;
  if (subassemblyDir) {
    fs.mkdirSync(subassemblyDir, { recursive: true });
  }
  
  const inv = inventoryToCompactJson(params.inventory);

  const promptText = [
    `You are planning the "${params.subassemblyName}" subassembly.`,
    "",
    `Description: ${params.subassemblyDescription}`,
    params.imageLocation ? `Image location: ${params.imageLocation}` : "",
    "",
    "TASK: Look at the reference image and create a detailed step-by-step plan for ONLY this subassembly.",
    "",
    "Requirements:",
    `- Focus on the part of the image showing: ${params.subassemblyDescription}`,
    `- Target ~${params.targetPieceCount} pieces for this subassembly`,
    "- Each step should add NO MORE THAN 5 parts",
    "- Steps should build logically (foundation first, details last)",
    "- Keep titles SHORT (max 50 chars)",
    "- Keep descriptions BRIEF (max 100 chars)",
    "",
    "Available parts:",
    inv
  ].filter(x => x !== "").join("\n");

  const dataUrl = readFileAsDataUrl({ filePath: params.referenceImagePath, mimeType: "image/png" });
  const content: Array<Record<string, unknown>> = [
    { type: "input_text", text: promptText },
    { type: "input_image", image_url: dataUrl }
  ];

  // Log to debug files only
  logOpenAI("info", `Planning "${params.subassemblyName}"...`);
  if (subassemblyDir) {
    fs.writeFileSync(`${subassemblyDir}/plan_input.txt`, promptText, "utf8");
    fs.copyFileSync(params.referenceImagePath, `${subassemblyDir}/reference.png`);
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["subassembly_name", "image_location_description", "steps", "estimated_pieces"],
    properties: {
      subassembly_name: { type: "string" },
      image_location_description: { type: "string", maxLength: 200 },
      steps: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["step", "title", "description"],
          properties: {
            step: { type: "integer", minimum: 1 },
            title: { type: "string", minLength: 1, maxLength: 50 },
            description: { type: "string", minLength: 5, maxLength: 100 }
          }
        }
      },
      estimated_pieces: { type: "integer", minimum: 1 }
    }
  } as const;

  const resp = await callOpenAIJsonInput<SubassemblyStepPlan>(
    { input: [{ role: "user", content }], schemaName: "subassembly_step_plan", schema },
    { reasoningEffort: "medium", maxOutputTokens: 25000 }
  );

  // Log to debug files only
  logOpenAI("info", `✓ Step plan: ${resp.parsed?.steps?.length || 0} steps, ~${resp.parsed?.estimated_pieces || "?"} pieces`);

  if (subassemblyDir && resp.parsed) {
    fs.writeFileSync(`${subassemblyDir}/plan_output.json`, JSON.stringify(resp.parsed, null, 2), "utf8");
  }

  return { plan: resp.parsed!, model: resp.model };
}

/**
 * PHASE 2b: Build and validate a single subassembly
 */
export async function buildAndValidateSubassembly(params: {
  subassemblyName: string;
  stepPlan: SubassemblyStepPlan;
  referenceImagePath: string;
  inventory: InventoryItem[];
  logDir?: string;
}): Promise<SubassemblyBuildResult> {
  const safeName = toFolderName(params.subassemblyName);
  const subassemblyDir = params.logDir ? `${params.logDir}/subassemblies/${safeName}` : null;
  const subassemblyLogFile = subassemblyDir ? `${subassemblyDir}/progress.log` : null;

  // Ensure directory exists (may have been created by step plan)
  if (subassemblyDir) {
    fs.mkdirSync(subassemblyDir, { recursive: true });
    fs.mkdirSync(`${subassemblyDir}/renders`, { recursive: true });
  }

  // Set up subassembly-specific logging
  if (subassemblyLogFile) {
    fs.writeFileSync(subassemblyLogFile, `=== ${params.subassemblyName} ===\nStarted: ${new Date().toISOString()}\nSteps: ${params.stepPlan.steps.length}\nTarget pieces: ${params.stepPlan.estimated_pieces}\n\n`);
    setCurrentSubassemblyLog(subassemblyLogFile);
  }
  
  // Update pipeline-level status
  pipelineStatus(params.subassemblyName, "Building started");

  // Detailed logging for debug files
  logOpenAI("info", `Building "${params.subassemblyName}" (${params.stepPlan.steps.length} steps, ~${params.stepPlan.estimated_pieces} pieces)`);

  if (subassemblyDir) {
    fs.writeFileSync(`${subassemblyDir}/build_plan.json`, JSON.stringify(params.stepPlan, null, 2), "utf8");
    // Reference image should already be there from planning step
    if (!fs.existsSync(`${subassemblyDir}/reference.png`)) {
      fs.copyFileSync(params.referenceImagePath, `${subassemblyDir}/reference.png`);
    }
  }

  // Convert step plan to the format expected by generateLDrawMpdChunkForIdea
  const blueprintForSubassembly: LDrawBlueprint = {
    structure_plan: {
      overview: params.stepPlan.image_location_description,
      subassemblies: [{ name: params.subassemblyName, description: params.stepPlan.image_location_description }]
    },
    step_outline: params.stepPlan.steps.map(s => ({
      step: s.step,
      title: s.title,
      description: s.description,
      subassembly_name: params.subassemblyName
    })),
    notes: []
  };

  const validationResults: Array<{ 
    round: number; 
    similarity?: number; 
    error?: string;
    rendered_image_path?: string;
  }> = [];
  
  // Use the tool loop to generate and validate
  const result = await generateLDrawMpdChunkForIdea({
    title: params.subassemblyName,
    userPrompt: params.stepPlan.image_location_description,
    blueprint: blueprintForSubassembly,
    stepFrom: 1,
    stepTo: params.stepPlan.steps.length,
    inventory: params.inventory,
    referenceImagePath: params.referenceImagePath,
    assembledMpdSoFar: "",
    visualFeedbackMode: "subassemblies", // Send visual feedback at subassembly completion
    isSubassemblyBoundary: true,
    isFinalChunk: false,
    currentChunkNumber: 1,
    totalChunks: 1,
    useValidationToolLoop: true,
    onEvent: (event) => {
      if (event.type === "round_start") {
        logToFile(`GPT generating... (round ${event.round})`);
      } else if (event.type === "tool_results") {
        event.results.forEach((r: any) => {
          const roundNum = validationResults.length + 1;
          const entry: { round: number; similarity?: number; error?: string; rendered_image_path?: string } = {
            round: roundNum
          };
          
          if (r.ok) {
            entry.similarity = r.similarity_score;
            logToFile(`Validation Round ${roundNum}: PASSED`);
            logToFile(`  ✓ Structure`);
            if (r.similarity_score !== undefined) {
              logToFile(`  Similarity: ${(r.similarity_score * 100).toFixed(0)}%`);
            }
          } else {
            entry.error = r.error;
            logToFile(`Validation Round ${roundNum}: FAILED`);
            if (r.issues) {
              r.issues.forEach((issue: any) => {
                logToFile(`  ✗ ${issue.type}: ${issue.message.split('\n')[0]}`);
              });
            } else if (r.error) {
              logToFile(`  Error: ${r.error.split('\n')[0]}`);
            }
            logToFile(`  GPT refining...`);
          }
          
          if (r.rendered_image_path) {
            entry.rendered_image_path = r.rendered_image_path;
            if (subassemblyDir && fs.existsSync(r.rendered_image_path)) {
              const destPath = `${subassemblyDir}/renders/round${roundNum}.png`;
              fs.copyFileSync(r.rendered_image_path, destPath);
            }
          }
          
          validationResults.push(entry);
        });
      }
    }
  });

  const finalSimilarity = validationResults.reverse().find(r => r.similarity !== undefined)?.similarity;
  const actualPieces = result.chunkBody.split('\n').filter((l: string) => l.trim().startsWith('1 ')).length;
  
  // Log to debug file only
  logOpenAI("info", `✓ "${params.subassemblyName}" complete (${actualPieces} pieces, ${validationResults.length} rounds)`);

  if (subassemblyDir) {
    fs.writeFileSync(`${subassemblyDir}/ldraw.mpd`, result.chunkBody, "utf8");
    fs.writeFileSync(`${subassemblyDir}/validation.json`, JSON.stringify(validationResults, null, 2), "utf8");
  }
  
  // Finalize subassembly log
  if (subassemblyLogFile) {
    fs.appendFileSync(subassemblyLogFile, `\n=== COMPLETE ===\nPieces: ${actualPieces}\nValidation rounds: ${validationResults.length}\nFinished: ${new Date().toISOString()}\n`);
    setCurrentSubassemblyLog(null);
  }
  
  // Update pipeline-level status
  pipelineStatus(params.subassemblyName, `Complete (${actualPieces} pieces, ${validationResults.length} rounds)`);

  return {
    subassembly_name: params.subassemblyName,
    ldraw_mpd: result.chunkBody,
    actual_pieces: actualPieces,
    validation_rounds: validationResults.length,
    final_similarity_score: finalSimilarity
  };
}

/**
 * PHASE 3: Assemble all subassemblies into final product and validate
 */
export async function assembleFinalProduct(params: {
  structurePlan: LDrawStructurePlan;
  subassemblyResults: SubassemblyBuildResult[];
  referenceImagePath: string;
  inventory: InventoryItem[];
  logDir?: string;
}): Promise<{ finalMpd: string; validationRounds: number; finalSimilarity?: number }> {
  const finalDir = params.logDir ? `${params.logDir}/final_assembly` : null;
  if (finalDir) {
    fs.mkdirSync(finalDir, { recursive: true });
    fs.mkdirSync(`${finalDir}/renders`, { recursive: true });
  }

  status("\nCombining subassemblies...");
  status(`Subassemblies: ${params.subassemblyResults.length}`, 1);
  
  const totalPieces = params.subassemblyResults.reduce((sum, sa) => sum + sa.actual_pieces, 0);
  status(`Total pieces: ${totalPieces}`, 1);

  // Combine all subassembly MPDs into a multi-part file
  // Sanitize names: replace spaces with underscores for LDraw compatibility
  const sanitizeName = (name: string) => name.replace(/\s+/g, '_');
  
  const combinedMpd = params.subassemblyResults.map(sa => {
    const safeName = sanitizeName(sa.subassembly_name);
    return `0 FILE ${safeName}.ldr\n${sa.ldraw_mpd}\n0 NOFILE`;
  }).join('\n\n') + '\n\n0 FILE main.ldr\n' + 
    params.subassemblyResults.map((sa, i) => {
      const safeName = sanitizeName(sa.subassembly_name);
      // Stack subassemblies vertically with 20-unit spacing (GPT will refine this)
      return `1 16 0 ${-i * 20} 0 1 0 0 0 1 0 0 0 1 ${safeName}.ldr`;
    }).join('\n');

  if (finalDir) {
    fs.writeFileSync(`${finalDir}/input_combined.mpd`, combinedMpd, "utf8");
  }

  // Build a blueprint for the final assembly refinement
  const finalBlueprint: LDrawBlueprint = {
    structure_plan: {
      overview: params.structurePlan.overview,
      subassemblies: params.subassemblyResults.map(sa => ({
        name: sa.subassembly_name,
        description: `Already built (${sa.actual_pieces} pieces)`
      }))
    },
    step_outline: [
      {
        step: 1,
        title: "Position all subassemblies",
        description: "Arrange subassemblies to match reference image proportions and layout",
        subassembly_name: "Final Assembly"
      }
    ],
    notes: ["Refine positioning based on visual feedback"]
  };

  const promptText = [
    "You are positioning the final LEGO model assembly.",
    "",
    `Overview: ${params.structurePlan.overview}`,
    "",
    "The following subassemblies have been built:",
    ...params.subassemblyResults.map(sa => `- ${sa.subassembly_name} (${sa.actual_pieces} pieces)`),
    "",
    "TASK: Adjust the coordinates in main.ldr to position each subassembly correctly.",
    "Match the reference image's proportions, spacing, and overall layout.",
    "",
    "Current combined MPD (you can only modify the coordinates in main.ldr):",
    combinedMpd
  ].join('\n');

  if (finalDir) {
    fs.writeFileSync(`${finalDir}/prompt.txt`, promptText, "utf8");
    fs.copyFileSync(params.referenceImagePath, `${finalDir}/reference.png`);
  }

  status("GPT refining assembly positions...", 1);
  
  const validationResults: Array<{ 
    round: number; 
    similarity?: number; 
    error?: string;
    rendered_image_path?: string;
  }> = [];
  
  // Use tool loop for final validation and refinement
  // Skip part validation since we're only adjusting coordinates, not adding new parts
  const result = await generateLDrawMpdChunkForIdea({
    title: "Final Assembly",
    userPrompt: promptText,
    blueprint: finalBlueprint,
    stepFrom: 1,
    stepTo: 1,
    inventory: params.inventory,
    referenceImagePath: params.referenceImagePath,
    assembledMpdSoFar: combinedMpd,
    visualFeedbackMode: "final_only",
    isSubassemblyBoundary: false,
    isFinalChunk: true,
    currentChunkNumber: 1,
    totalChunks: 1,
    useValidationToolLoop: true,
    skipPartValidation: true, // Assembly refinement only adjusts coordinates
    onEvent: (event) => {
      if (event.type === "round_start") {
        status(`Validation round ${event.round}...`, 1);
      } else if (event.type === "tool_results") {
        event.results.forEach((r: any) => {
          const roundNum = validationResults.length + 1;
          const entry: { round: number; similarity?: number; error?: string; rendered_image_path?: string } = {
            round: roundNum
          };
          
          if (r.similarity_score !== undefined) {
            entry.similarity = r.similarity_score;
            status(`Similarity: ${(r.similarity_score * 100).toFixed(0)}% ${r.ok ? "✓" : "✗"}`, 2);
          }
          if (r.error) {
            entry.error = r.error;
            status(`Error: ${r.error.split('\n')[0]}`, 2);
          }
          if (r.rendered_image_path) {
            entry.rendered_image_path = r.rendered_image_path;
            
            // Copy rendered image to log directory
            if (finalDir && fs.existsSync(r.rendered_image_path)) {
              const destPath = `${finalDir}/renders/round${roundNum}.png`;
              fs.copyFileSync(r.rendered_image_path, destPath);
            }
          }
          
          validationResults.push(entry);
        });
      }
    }
  });

  const finalSimilarity = validationResults.reverse().find(r => r.similarity !== undefined)?.similarity;

  statusResult("Final assembly", true, `${validationResults.length} rounds`);
  if (finalSimilarity !== undefined) {
    status(`Final similarity: ${(finalSimilarity * 100).toFixed(0)}%`, 1);
  }

  if (finalDir) {
    fs.writeFileSync(`${finalDir}/output.mpd`, result.chunkBody, "utf8");
    fs.writeFileSync(`${finalDir}/validation.json`, JSON.stringify(validationResults, null, 2), "utf8");
  }

  return {
    finalMpd: result.chunkBody,
    validationRounds: validationResults.length,
    finalSimilarity
  };
}

/**
 * ORCHESTRATOR: Run the complete multi-phase build pipeline
 */
export async function generateBlueprintMultiPhase(params: {
  referenceImagePath: string;
  inventory: InventoryItem[];
  constraintsText?: string;
  logDir?: string;
  /** Debug mode: only build first subassembly, skip final assembly (default: true) */
  debugMode?: boolean;
}): Promise<{ 
  structurePlan: LDrawStructurePlan;
  subassemblyResults: SubassemblyBuildResult[];
  finalMpd: string | null;
}> {
  const startTime = Date.now();
  const debugMode = params.debugMode ?? true;

  // =========================================================================
  // STEP 1: Generate Structure Plan
  // =========================================================================
  statusHeader(1, "Generating Structure Plan");
  status("Analyzing reference image...");
  
  const phase1 = await generateStructurePlan(params);
  
  status(`Approx. Parts: ${phase1.plan.estimated_total_pieces}`);
  status(`Sub-Assemblies: ${phase1.plan.subassemblies.length}`);
  phase1.plan.subassemblies.forEach((sa, i) => {
    status(`${i + 1}. ${sa.name}`, 1);
  });

  // =========================================================================
  // STEP 2: Generate Detailed Plans
  // =========================================================================
  statusHeader(2, "Generating Detailed Plans");
  
  const totalPieces = phase1.plan.estimated_total_pieces;
  const subassembliesToProcess = debugMode 
    ? phase1.plan.subassemblies.slice(0, 1) 
    : phase1.plan.subassemblies;
  
  if (debugMode && phase1.plan.subassemblies.length > 1) {
    status(`(Debug mode: processing 1 of ${phase1.plan.subassemblies.length})`);
  }
  
  const stepPlanPromises = subassembliesToProcess.map(async (sa) => {
    const targetPieces = Math.floor(totalPieces / phase1.plan.subassemblies.length);
    return generateSubassemblyStepPlan({
      subassemblyName: sa.name,
      subassemblyDescription: sa.description,
      imageLocation: sa.image_location,
      referenceImagePath: params.referenceImagePath,
      inventory: params.inventory,
      targetPieceCount: targetPieces,
      logDir: params.logDir
    });
  });
  const stepPlans = await Promise.all(stepPlanPromises);
  
  stepPlans.forEach((sp) => {
    statusResult(sp.plan.subassembly_name, true, `${sp.plan.steps.length} steps, ~${sp.plan.estimated_pieces} pieces`);
  });

  // =========================================================================
  // STEP 3: Build Sub-Assemblies (parallel)
  // =========================================================================
  statusHeader(3, "Building Sub-Assemblies");
  
  // Show all triggered
  status("Started:");
  stepPlans.forEach(sp => status(sp.plan.subassembly_name, 1));
  status("");
  
  // Track completions
  let completedCount = 0;
  const totalCount = stepPlans.length;
  
  // Build all in parallel
  const buildPromises = stepPlans.map(async (sp) => {
    const result = await buildAndValidateSubassembly({
      subassemblyName: sp.plan.subassembly_name,
      stepPlan: sp.plan,
      referenceImagePath: params.referenceImagePath,
      inventory: params.inventory,
      logDir: params.logDir
    });
    completedCount++;
    status(`Completed [${completedCount}/${totalCount}]: ${sp.plan.subassembly_name} (${result.actual_pieces} pieces)`);
    return result;
  });
  
  const buildResults = await Promise.all(buildPromises);

  // =========================================================================
  // STEP 4: Final Assembly
  // =========================================================================
  let finalMpd: string | null = null;
  let phase3ValidationRounds = 0;
  
  if (debugMode) {
    statusHeader(4, "Final Assembly (Skipped - Debug Mode)");
  } else {
    statusHeader(4, "Combining Sub-Assemblies");
    status("Assembling final model...");
    
    const phase3 = await assembleFinalProduct({
      structurePlan: phase1.plan,
      subassemblyResults: buildResults,
      referenceImagePath: params.referenceImagePath,
      inventory: params.inventory,
      logDir: params.logDir
    });
    finalMpd = phase3.finalMpd;
    phase3ValidationRounds = phase3.validationRounds;
    
    statusResult("Final assembly", true, `${phase3ValidationRounds} validation rounds`);
  }

  // =========================================================================
  // SUMMARY
  // =========================================================================
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${"═".repeat(50)}`);
  console.log("COMPLETE");
  console.log("═".repeat(50));
  status(`Time: ${totalTime}s`);
  status(`Sub-assemblies: ${buildResults.length}${debugMode ? " (debug)" : ""}`);
  status(`Total pieces: ${buildResults.reduce((sum, br) => sum + br.actual_pieces, 0)}`);
  status(`Validation rounds: ${buildResults.reduce((sum, br) => sum + br.validation_rounds, 0) + phase3ValidationRounds}`);
  
  if (params.logDir) {
    status(`Output: ${params.logDir}`);
  }

  return {
    structurePlan: phase1.plan,
    subassemblyResults: buildResults,
    finalMpd
  };
}

/**
 * LEGACY: Generate a build blueprint from a user-uploaded reference image.
 * 
 * @deprecated Use generateBlueprintMultiPhase for better reliability and parallelization
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
  /** Title extracted from image analysis */
  title?: string;
  /** Detailed description of what to build (from image analysis) */
  description?: string;
  /** @deprecated - Use title + description from analyzeImageForBuild instead */
  userPrompt?: string;
  inventory: InventoryItem[];
  constraintsText?: string;
  /** Path to user-uploaded reference image (PNG). Used for visual reference. */
  referenceImagePath?: string;
  /** @deprecated Use referenceImagePath instead */
  previewImagePath?: string;
}): Promise<{ blueprint: LDrawBlueprint; model: string; usage?: TokenUsage }> {
  // Support both old and new parameter names during transition
  const imagePath = params.referenceImagePath || params.previewImagePath;
  
  if (!imagePath || !fs.existsSync(imagePath)) {
    throw new Error("Reference image is required for blueprint generation");
  }
  
  const inv = inventoryToCompactJson(params.inventory);
  const constraints = params.constraintsText?.trim() ? params.constraintsText.trim() : "(none)";

  const promptText = [
    "You are an expert LEGO MOC designer and instruction planner.",
    "",
    "TASK: Look at the reference image and create a blueprint for building it with LEGO.",
    "",
    "Requirements:",
    "- Build what you see in the image (match colors, shapes, proportions)",
    "- Use only parts available in the provided inventory",
    "- Keep it simple and buildable",
    "",
    "STEP PLANNING:",
    "- Each step should add NO MORE THAN 5 parts",
    "- Total piece budget: 25-500 pieces for complete model",
    "- Steps should be logical construction phases",
    "- Each step MUST include 'subassembly_name' matching one of your structure_plan.subassemblies[].name",
    "- Keep step titles SHORT (max 50 chars)",
    "- Keep step descriptions BRIEF (max 100 chars)",
    "",
    "Constraints:",
    constraints,
    "",
    "Available parts (JSON map of partNum -> color -> qty):",
    inv
  ].filter(x => x !== "").join("\n");

  const hasReferenceImage = imagePath && fs.existsSync(imagePath);
  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: promptText }];
  if (hasReferenceImage) {
    const dataUrl = readFileAsDataUrl({ filePath: imagePath, mimeType: "image/png" });
    content.push({ type: "input_image", image_url: dataUrl });
  }

  // Log the blueprint request
  logOpenAI("info", `Generating blueprint (${params.inventory.length} parts available)...`);
  
  // Debug artifact: write the exact prompt + a copy of the reference image (if present) for review.
  let debugInputId: string | null = null;
  if (isDebugEnabled()) {
    try {
      const dir = getDebugDir("api_calls");
      const id = generateArtifactId("blueprint_input");
      debugInputId = id;
      let copiedImageRelPath: string | null = null;
      if (hasReferenceImage) {
        const outImg = path.join(dir, `${id}.png`);
        fs.copyFileSync(imagePath, outImg);
        copiedImageRelPath = path.relative(process.cwd(), outImg);
        logOpenAI("debug", `Blueprint reference image saved: ${outImg}`);
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
      logOpenAI("debug", `Blueprint input artifact: ${outJson}`);
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
          required: ["step", "title", "subassembly_name"],
          properties: {
            step: { type: "integer", minimum: 1 },
            title: { type: "string", minLength: 1, maxLength: 50 },
            description: { type: "string", minLength: 1, maxLength: 100 },
            subassembly_name: { 
              type: "string", 
              minLength: 1,
              description: "Which subassembly this step belongs to (must match one of structure_plan.subassemblies[].name)" 
            }
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
  logOpenAI("info", `Calling GPT for blueprint...`);
  
  const resp = await callOpenAIJsonInput<LDrawBlueprint>(
    { input: [{ role: "user", content }], schemaName: "lego_ldraw_blueprint", schema },
    { reasoningEffort, maxOutputTokens: Math.floor(maxOutputTokens) }
  );
  const durationMs = Date.now() - startedAtMs;
  const rawResponse = resp.rawResponseJson as Record<string, unknown>;
  const rawUsage = (rawResponse as any)?.usage;
  
  const durationSec = (durationMs / 1000).toFixed(1);
  logOpenAI("info", `✓ Blueprint received (${durationSec}s, ${rawUsage?.total_tokens || "?"} tokens)`);
  logOpenAI("info", `  ${resp.parsed?.step_outline?.length || 0} steps, ${resp.parsed?.structure_plan?.subassemblies?.length || 0} subassemblies`);

  if (isDebugEnabled()) {
    try {
      const dir = getDebugDir("api_calls");
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
      logOpenAI("debug", `Blueprint response artifact: ${outJson}`);
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


