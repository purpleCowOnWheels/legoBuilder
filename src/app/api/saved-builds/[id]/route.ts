import { NextResponse } from "next/server";
import { readDb, writeDb } from "@/lib/storage";

export async function DELETE(_req: Request, ctx: { params: { id: string } }) {
  const id = ctx.params.id;
  const db = readDb();
  const before = db.savedBuilds.length;
  db.savedBuilds = db.savedBuilds.filter((b) => b.id !== id);
  if (db.savedBuilds.length === before) return NextResponse.json({ error: "Not found" }, { status: 404 });
  writeDb(db);
  return NextResponse.json({ ok: true });
}


