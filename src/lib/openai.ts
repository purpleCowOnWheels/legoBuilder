import { InventoryItem } from "@/lib/models";
import fs from "node:fs";
import path from "node:path";

type OpenAIResponse = {
  output_text?: string;
  output?: Array<{
    type: string;
    content?: Array<{ type: string; text?: string }>;
  }>;
};

type ImageGenResponse = {
  data?: Array<{ b64_json?: string; url?: string }>;
};

function inventoryToCompactText(inventory: InventoryItem[]) {
  // Keep the prompt compact and deterministic.
  const lines = inventory
    .slice()
    .sort((a, b) => (a.partNum + a.colorName).localeCompare(b.partNum + b.colorName))
    .map((i) => `- ${i.quantity}x ${i.partName} (${i.partNum}) [${i.colorName}]`);
  return lines.join("\n");
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

async function callOpenAIJson<T>(params: { prompt: string; schemaName: string; schema: unknown }) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
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
      input: params.prompt,
      temperature: 0,
      // Note: In the Responses API, structured outputs are configured via `text.format`
      // (not `response_format`).
      text: {
        format: {
          type: "json_schema",
          name: params.schemaName,
          schema: params.schema,
          strict: true
        }
      }
    })
  });

  if (!res.ok) {
    throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as OpenAIResponse;
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
  const inv = inventoryToCompactText(params.inventory);
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
    "Inventory:",
    inv
  ].join("\n");

  return await callOpenAI(prompt);
}

export async function expandGuide(params: { goal: string; inventory: InventoryItem[]; draftGuideMarkdown: string }) {
  const inv = inventoryToCompactText(params.inventory);
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
    "Inventory:",
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
  // We generate an image from this (kept to let you regenerate later if desired)
  thumbnail_prompt: string;
};

export async function generateBuildIdeasStructured(params: {
  inventory: InventoryItem[];
  preferences?: string;
  targetPartsMin?: number;
  targetPartsMax?: number;
  difficulty?: "easy" | "medium" | "hard";
  age?: number;
  buildTimeMinutes?: number;
}): Promise<{ ideas: BuildIdea[]; model: string }> {
  const inv = inventoryToCompactText(params.inventory);
  const preferenceLine = params.preferences?.trim() ? params.preferences.trim() : "(none)";
  const constraints = [
    params.targetPartsMin || params.targetPartsMax
      ? `Target parts range: ${params.targetPartsMin ?? "?"}–${params.targetPartsMax ?? "?"}`
      : "Target parts range: (not specified)",
    params.difficulty ? `Difficulty: ${params.difficulty}` : "Difficulty: (not specified)",
    params.age ? `Age: ${params.age}+` : "Age: (not specified)"
    ,
    params.buildTimeMinutes ? `Build time target: ${params.buildTimeMinutes} minutes` : "Build time target: (not specified)"
  ].join("\n");

  const prompt = [
    "You are an expert LEGO MOC designer.",
    "Given a user's LEGO parts inventory, propose build ideas that are realistic with the available parts and the user's optional constraints.",
    "",
    "Return exactly 2 ideas (max).",
    "Use difficulty enum values: easy, medium, hard.",
    "For number_of_parts, estimate roughly how many parts the build would use (integer), aiming within the target range if provided.",
    "Also aim for the build time target if provided (in minutes).",
    "thumbnail_prompt must be a short prompt that could be used to generate a small thumbnail image of the finished build.",
    "",
    `User preferences: ${preferenceLine}`,
    "",
    "User constraints:",
    constraints,
    "",
    "Inventory:",
    inv
  ].join("\n");

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["ideas"],
    properties: {
      ideas: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "description", "number_of_parts", "difficulty", "thumbnail_prompt"],
          properties: {
            title: { type: "string", minLength: 1 },
            description: { type: "string", minLength: 1 },
            number_of_parts: { type: "integer", minimum: 1 },
            difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
            thumbnail_prompt: { type: "string", minLength: 1 }
          }
        }
      }
    }
  } as const;

  function validateIdeasPayload(payload: unknown): BuildIdea[] {
    if (typeof payload !== "object" || payload === null) throw new Error("OpenAI returned non-object JSON");
    const ideas = (payload as { ideas?: unknown }).ideas;
    if (!Array.isArray(ideas) || ideas.length === 0) throw new Error("OpenAI returned JSON without a non-empty ideas array");

    const normalized: BuildIdea[] = [];
    for (const raw of ideas) {
      if (typeof raw !== "object" || raw === null) throw new Error("OpenAI returned an invalid idea entry");
      const idea = raw as Partial<BuildIdea>;
      if (!idea.title || typeof idea.title !== "string") throw new Error("Idea missing title");
      if (!idea.description || typeof idea.description !== "string") throw new Error("Idea missing description");
      if (typeof idea.number_of_parts !== "number" || !Number.isFinite(idea.number_of_parts))
        throw new Error("Idea missing number_of_parts");
      if (idea.difficulty !== "easy" && idea.difficulty !== "medium" && idea.difficulty !== "hard")
        throw new Error("Idea missing/invalid difficulty");
      if (!idea.thumbnail_prompt || typeof idea.thumbnail_prompt !== "string")
        throw new Error("Idea missing thumbnail_prompt");
      normalized.push({
        title: idea.title.trim(),
        description: idea.description.trim(),
        number_of_parts: Math.max(1, Math.floor(idea.number_of_parts)),
        difficulty: idea.difficulty,
        thumbnail_prompt: idea.thumbnail_prompt.trim()
      });
    }
    return normalized.slice(0, 2);
  }

  const { parsed, model, rawResponseJson, extractedText } = await callOpenAIJson<{ ideas: BuildIdea[] }>({
    prompt,
    schemaName: "lego_build_ideas",
    schema
  });

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

export async function generateThumbnailDataUrl(params: { prompt: string }) {
  const apiKey = process.env.OPENAI_API_KEY;
  const imageModel = process.env.OPENAI_IMAGE_MODEL;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  if (!imageModel) {
    throw new Error("OPENAI_IMAGE_MODEL is not set");
  }

  // Keep thumbnails cheap/small.
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: imageModel,
      prompt: params.prompt,
      // gpt-image-1 supported sizes are currently: 1024x1024, 1024x1536, 1536x1024, auto
      size: "1024x1024"
    })
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    const debugId = writeOpenAIDebugArtifact({
      tag: "image_generation_error",
      prompt: params.prompt,
      rawResponseJson: { status: res.status, body: bodyText },
      extractedText: bodyText
    });
    throw new Error(
      `OpenAI image error ${res.status}.${debugId ? ` debugId=${debugId}` : ""} ${bodyText}`.trim()
    );
  }

  const json = (await res.json()) as ImageGenResponse;
  const b64 = json.data?.[0]?.b64_json;
  const url = json.data?.[0]?.url;

  let pngBytes: Buffer | null = null;
  if (b64) {
    pngBytes = Buffer.from(b64, "base64");
  } else if (url) {
    // Some responses may return a hosted URL instead of base64.
    const imgRes = await fetch(url);
    if (!imgRes.ok) {
      const bodyText = await imgRes.text().catch(() => "");
      const debugId = writeOpenAIDebugArtifact({
        tag: "image_download_error",
        prompt: params.prompt,
        rawResponseJson: { status: imgRes.status, body: bodyText, url },
        extractedText: bodyText
      });
      throw new Error(`OpenAI image download error ${imgRes.status}.${debugId ? ` debugId=${debugId}` : ""}`.trim());
    }
    const ab = await imgRes.arrayBuffer();
    pngBytes = Buffer.from(ab);
  }

  if (!pngBytes) {
    const debugId = writeOpenAIDebugArtifact({
      tag: "image_generation_missing_b64",
      prompt: params.prompt,
      rawResponseJson: json,
      extractedText: JSON.stringify(json)
    });
    throw new Error(
      `OpenAI image error: missing image bytes (no b64_json or url).${debugId ? ` debugId=${debugId}` : ""}`.trim()
    );
  }

  // Persist to disk (local dev) and return a URL path that Next can serve from /public.
  const outDir = path.join(process.cwd(), "public", "generated-thumbs");
  fs.mkdirSync(outDir, { recursive: true });
  const fileName = `thumb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.png`;
  const filePath = path.join(outDir, fileName);
  fs.writeFileSync(filePath, pngBytes);
  return { url: `/generated-thumbs/${fileName}`, imageModel };
}


