import { NextResponse } from "next/server";
import { readDb, writeDb } from "@/lib/storage";
import { newId } from "@/lib/ids";
import { enqueueIdeaJob } from "@/lib/ideaQueue";
import { extractTitleFromPrompt } from "@/lib/openai";
import fs from "node:fs";
import path from "node:path";

export async function GET() {
  const db = readDb();
  return NextResponse.json({ history: db.ideaSearches, debugOpenAi: process.env.DEBUG_OPENAI === "1" });
}

export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") || "";
  const isFormData = contentType.includes("multipart/form-data");

  let preferences: string | undefined;
  let targetPartsMin: number | undefined;
  let targetPartsMax: number | undefined;
  let difficulty: "easy" | "medium" | "hard" | undefined;
  let age: number | undefined;
  let buildTimeMinutes: number | undefined;
  let count: number | undefined;
  let inventoryMode: "basic" | "full" = "basic";
  let colorMode: "exact" | "bucketed" = "exact";
  let uploadedImage: File | null = null;

  if (isFormData) {
    const formData = await req.formData();
    preferences = (formData.get("preferences") as string) || undefined;
    const minStr = formData.get("targetPartsMin") as string | null;
    const maxStr = formData.get("targetPartsMax") as string | null;
    targetPartsMin = minStr ? Number(minStr) : undefined;
    targetPartsMax = maxStr ? Number(maxStr) : undefined;
    difficulty = (formData.get("difficulty") as "easy" | "medium" | "hard") || undefined;
    const ageStr = formData.get("age") as string | null;
    age = ageStr ? Number(ageStr) : undefined;
    const buildTimeStr = formData.get("buildTimeMinutes") as string | null;
    buildTimeMinutes = buildTimeStr ? Number(buildTimeStr) : undefined;
    const countStr = formData.get("count") as string | null;
    count = countStr ? Math.floor(Number(countStr)) : undefined;
    inventoryMode = (formData.get("inventoryMode") as "basic" | "full") || "basic";
    colorMode = (formData.get("colorMode") as "exact" | "bucketed") || "exact";
    uploadedImage = (formData.get("image") as File) || null;
  } else {
    const body = (await req.json().catch(() => null)) as null | {
      preferences?: string;
      targetPartsMin?: number;
      targetPartsMax?: number;
      difficulty?: "easy" | "medium" | "hard";
      age?: number;
      buildTimeMinutes?: number;
      count?: number;
      inventoryMode?: "basic" | "full";
      colorMode?: "exact" | "bucketed";
    };
    preferences = body?.preferences;
    targetPartsMin = typeof body?.targetPartsMin === "number" ? body?.targetPartsMin : undefined;
    targetPartsMax = typeof body?.targetPartsMax === "number" ? body?.targetPartsMax : undefined;
    difficulty = body?.difficulty;
    age = typeof body?.age === "number" ? body?.age : undefined;
    buildTimeMinutes = typeof body?.buildTimeMinutes === "number" ? body?.buildTimeMinutes : undefined;
    count = typeof body?.count === "number" ? Math.floor(body.count) : undefined;
    inventoryMode = body?.inventoryMode === "full" ? "full" : "basic";
    colorMode = body?.colorMode === "bucketed" ? "bucketed" : "exact";
  }

  const db = readDb();
  if (db.inventory.length === 0) {
    return NextResponse.json(
      { error: "Your inventory is empty. Add a set first so we have parts to work with." },
      { status: 400 }
    );
  }

  try {
    const now = new Date().toISOString();
    const searchId = newId("idea");

    // If image is uploaded, save it and create IdeaSearch directly (skip preview generation queue)
    if (uploadedImage && uploadedImage.size > 0) {
      const arrayBuffer = await uploadedImage.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      // Save uploaded image to public/generated-thumbs/
      const publicDir = path.join(process.cwd(), "public", "generated-thumbs");
      fs.mkdirSync(publicDir, { recursive: true });
      
      const ext = uploadedImage.name.split(".").pop() || "png";
      const baseName = `uploaded_${searchId}_${Date.now()}`;
      const fileName = `${baseName}.${ext}`;
      const filePath = path.join(publicDir, fileName);
      fs.writeFileSync(filePath, buffer);
      
      const thumbnailUrl = `/generated-thumbs/${fileName}`;
      
      // Extract title from prompt
      const title = await extractTitleFromPrompt({ userPrompt: preferences || "LEGO Build" });

      const updatedDb = readDb();
      updatedDb.ideaSearches.unshift({
        id: searchId,
        createdAt: now,
        title,
        preferences: preferences?.trim() || undefined,
        targetPartsMin,
        targetPartsMax,
        difficulty,
        age,
        buildTimeMinutes,
        count: 1, // Always 1 when image is uploaded
        inventoryMode,
        colorMode,
        status: "done", // Skip queuing - already complete
        updatedAt: now,
        ideas: [
          {
            title,
            preview_thumbnail: thumbnailUrl,
            previewStatus: "done",
            ldrawStatus: "not_started"
          }
        ]
      });
      writeDb(updatedDb);

      return NextResponse.json({ searchId, debugOpenAi: process.env.DEBUG_OPENAI === "1" });
    }

    // No image: use existing flow (generate preview images via OpenAI)
    const updatedDb = readDb();
    updatedDb.ideaSearches.unshift({
      id: searchId,
      createdAt: now,
      preferences: preferences?.trim() || undefined,
      targetPartsMin,
      targetPartsMax,
      difficulty,
      age,
      buildTimeMinutes,
      count,
      inventoryMode,
      colorMode,
      status: "queued",
      updatedAt: now,
      ideas: []
    });
    writeDb(updatedDb);

    const job = enqueueIdeaJob(searchId);
    // Link job back to the search
    const db2 = readDb();
    const s2 = db2.ideaSearches.find((s) => s.id === searchId);
    if (s2) {
      s2.jobId = job.id;
      s2.updatedAt = new Date().toISOString();
      writeDb(db2);
    }

    // Return immediately; UI will poll status.
    return NextResponse.json({ searchId, jobId: job.id, debugOpenAi: process.env.DEBUG_OPENAI === "1" });
  } catch (e) {
    // Surface debugId in errors (if enabled) so you can find artifacts under data/openai-debug/.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to generate ideas" },
      { status: 500 }
    );
  }
}


