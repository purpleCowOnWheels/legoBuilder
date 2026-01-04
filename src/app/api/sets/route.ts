import { NextResponse } from "next/server";
import { readDb, writeDb } from "@/lib/storage";
import { newId } from "@/lib/ids";
import { getPartsForSet } from "@/lib/rebrickable";
import { applyPartsDelta } from "@/lib/inventory";

function normalizeSetNum(input: string) {
  const trimmed = input.trim();
  // Rebrickable uses set numbers like "10698-1". If user enters "10698", assume variant "-1".
  if (/^\d+$/.test(trimmed)) return `${trimmed}-1`;
  return trimmed;
}

export async function GET() {
  const db = readDb();
  return NextResponse.json({ sets: db.sets });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as null | { setNum?: string; name?: string };
  const rawSetNum = body?.setNum || "";
  const setNum = normalizeSetNum(rawSetNum);
  const name = (body?.name || "").trim() || setNum;

  if (!setNum) return NextResponse.json({ error: "setNum is required" }, { status: 400 });

  const db = readDb();
  const parts = await getPartsForSet(setNum);
  if (parts.length === 0) {
    return NextResponse.json(
      {
        error: `No parts found for "${setNum}". If you entered a bare number, try the full Rebrickable set number like "10698-1".`
      },
      { status: 422 }
    );
  }

  const now = new Date().toISOString();
  const legoSet = {
    id: newId("set"),
    setNum,
    name,
    createdAt: now,
    parts
  };

  db.sets.unshift(legoSet);
  db.inventory = applyPartsDelta({ inventory: db.inventory, parts, direction: "add" });
  writeDb(db);

  return NextResponse.json({ set: legoSet, inventory: db.inventory }, { status: 201 });
}


