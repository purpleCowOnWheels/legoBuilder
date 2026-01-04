import { NextResponse } from "next/server";
import { readDb } from "@/lib/storage";

export async function GET() {
  const db = readDb();
  return NextResponse.json({ inventory: db.inventory });
}


