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
  "Each idea must have: title (string), description (string), estimated_time_minutes (int), spec (object with concept, key_features, color_palette, step_count_estimate)."
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
        required: ["title", "description", "estimated_time_minutes", "spec"],
        properties: {
          title: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          estimated_time_minutes: { type: "integer", minimum: 1 },
          spec: {
            type: "object",
            additionalProperties: false,
            required: ["concept", "key_features", "color_palette", "step_count_estimate"],
            properties: {
              concept: { type: "string", minLength: 1 },
              key_features: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
              color_palette: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
              step_count_estimate: { type: "integer", minimum: 1 }
            }
          }
        }
      }
    }
  }
};

const body = {
  model,
  input: prompt,
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


