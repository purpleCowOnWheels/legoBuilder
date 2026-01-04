import { NextResponse } from "next/server";
import { readDb } from "@/lib/storage";
import { generateBuildIdeas } from "@/lib/openai";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as null | { preferences?: string };
  const preferences = body?.preferences;

  const db = readDb();
  if (db.inventory.length === 0) {
    return NextResponse.json(
      { error: "Your inventory is empty. Add a set first so we have parts to work with." },
      { status: 400 }
    );
  }

  try {
    const { text, model } = await generateBuildIdeas({ inventory: db.inventory, preferences });
    return NextResponse.json({ ideasMarkdown: text, model });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to generate ideas" },
      { status: 500 }
    );
  }
}


