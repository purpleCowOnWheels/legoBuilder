/**
 * Minimal integration test for OpenAI Images API.
 *
 * Usage:
 *   OPENAI_API_KEY=... OPENAI_IMAGE_MODEL=... node tests/openai-image.test.mjs
 *
 * Exits non-zero on failure.
 */

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_IMAGE_MODEL;

if (!apiKey) {
  console.error("OPENAI_API_KEY is not set");
  process.exit(1);
}
if (!model) {
  console.error("OPENAI_IMAGE_MODEL is not set");
  process.exit(1);
}

const body = {
  model,
  prompt: "A tiny LEGO spaceship made from colorful bricks, studio lighting, simple background",
  size: "1024x1024"
};

const res = await fetch("https://api.openai.com/v1/images/generations", {
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
const first = json.data?.[0];
console.log("Model:", model);
console.log("Response keys:", Object.keys(json));
console.log("First data keys:", first ? Object.keys(first) : "(none)");
console.log("Has b64_json:", Boolean(first?.b64_json));
console.log("Has url:", Boolean(first?.url));


