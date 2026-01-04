/**
 * Minimal integration test for OpenAI Responses API Structured Outputs.
 *
 * Usage:
 *   OPENAI_API_KEY=... OPENAI_MODEL=... node tests/openai-structured.test.mjs
 *
 * Exits non-zero on failure.
 */

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL;

if (!apiKey) {
  console.error("OPENAI_API_KEY is not set");
  process.exit(1);
}
if (!model) {
  console.error("OPENAI_MODEL is not set");
  process.exit(1);
}

const prompt = [
  "Return JSON only.",
  "Return exactly 2 ideas.",
  "Each idea must have: title (string), description (string), number_of_parts (int), difficulty (easy|medium|hard), thumbnail_prompt (string)."
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
};

const body = {
  model,
  input: prompt,
  temperature: 0,
  text: {
    format: {
      type: "json_schema",
      name: "lego_build_ideas_test",
      schema,
      strict: true
    }
  }
};

const res = await fetch("https://api.openai.com/v1/responses", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify(body)
});

const raw = await res.text();
if (!res.ok) {
  console.error("HTTP", res.status, raw);
  process.exit(1);
}

const json = JSON.parse(raw);
const outputText =
  (typeof json.output_text === "string" && json.output_text) ||
  (Array.isArray(json.output)
    ? json.output
        .flatMap((o) => o.content || [])
        .map((c) => c.text)
        .filter(Boolean)
        .join("\n\n")
    : "");

console.log("Model:", model);
console.log("Output text:\n", outputText);
console.log("\nRaw response keys:", Object.keys(json));


