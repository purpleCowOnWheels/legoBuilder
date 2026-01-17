import fs from "node:fs";
import path from "node:path";

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeBaseName(base: string) {
  return base.replaceAll(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

export function writeGeneratedThumbPng(params: { baseName: string; pngBase64: string }) {
  const outDir = path.join(process.cwd(), "public", "generated-thumbs");
  ensureDir(outDir);
  const base = safeBaseName(params.baseName);
  const outPath = path.join(outDir, `${base}.png`);
  fs.writeFileSync(outPath, Buffer.from(params.pngBase64, "base64"));
  return { url: `/generated-thumbs/${path.basename(outPath)}`, outPath };
}


