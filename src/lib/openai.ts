import { InventoryItem } from "@/lib/models";

type OpenAIResponse = {
  output_text?: string;
  output?: Array<{
    type: string;
    content?: Array<{ type: string; text?: string }>;
  }>;
};

function inventoryToCompactText(inventory: InventoryItem[]) {
  // Keep the prompt compact and deterministic.
  const lines = inventory
    .slice()
    .sort((a, b) => (a.partNum + a.colorName).localeCompare(b.partNum + b.colorName))
    .map((i) => `- ${i.quantity}x ${i.partName} (${i.partNum}) [${i.colorName}]`);
  return lines.join("\n");
}

async function callOpenAI(prompt: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

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
  const text =
    (typeof json.output_text === "string" && json.output_text.trim().length > 0
      ? json.output_text
      : json.output
          ?.flatMap((o) => o.content ?? [])
          .filter((c) => typeof c.text === "string" && c.text.trim().length > 0)
          .map((c) => c.text)
          .join("\n\n")) || "";
  return { text, model };
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

export async function generateBuildIdeas(params: { inventory: InventoryItem[]; preferences?: string }) {
  const inv = inventoryToCompactText(params.inventory);
  const prompt = [
    "You are an expert LEGO MOC designer.",
    "Given a user's LEGO parts inventory, propose build ideas that are realistic with the available parts.",
    "",
    "Output requirements:",
    "- Output Markdown.",
    "- Provide 8 ideas.",
    "- For each idea: a short name, 1–2 sentence description, and a difficulty (Easy/Medium/Hard).",
    "- If wheels/minifig parts are not in inventory, avoid ideas that require them.",
    "",
    params.preferences?.trim() ? `User preferences: ${params.preferences.trim()}` : "User preferences: (none)",
    "",
    "Inventory:",
    inv
  ].join("\n");

  return await callOpenAI(prompt);
}


