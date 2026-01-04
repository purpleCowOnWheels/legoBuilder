import { NextResponse } from "next/server";
import { readDb, writeDb } from "@/lib/storage";

export async function DELETE(_: Request, ctx: { params: { id: string } }) {
  const id = ctx.params.id;
  const db = readDb();
  const before = db.ideaSearches.length;
  db.ideaSearches = db.ideaSearches.filter((s) => s.id !== id);
  if (db.ideaSearches.length === before) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  writeDb(db);
  return NextResponse.json({ ok: true });
}


