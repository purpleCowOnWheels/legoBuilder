import { NextResponse } from "next/server";
import { readDb, writeDb } from "@/lib/storage";
import { applyPartsDelta } from "@/lib/inventory";

export async function DELETE(_: Request, ctx: { params: { id: string } }) {
  const id = ctx.params.id;
  const db = readDb();
  const idx = db.sets.findIndex((s) => s.id === id);
  if (idx === -1) return NextResponse.json({ error: "Set not found" }, { status: 404 });

  const [removed] = db.sets.splice(idx, 1);
  db.inventory = applyPartsDelta({ inventory: db.inventory, parts: removed.parts, direction: "subtract" });
  writeDb(db);

  return NextResponse.json({ ok: true, removedId: id, inventory: db.inventory });
}


