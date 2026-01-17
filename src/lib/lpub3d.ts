import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { countLDrawSteps } from "@/lib/ldraw";

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function getLPub3DBin() {
  return process.env.LPUB3D_BIN || "/Applications/LPub3D.app/Contents/MacOS/LPub3D";
}

function assertLPub3DAvailable() {
  const bin = getLPub3DBin();
  if (!fs.existsSync(bin)) {
    throw new Error(
      `LPub3D binary not found at ${bin}. Install LPub3D to /Applications or set LPUB3D_BIN to the executable path.`
    );
  }
  return bin;
}

function safeBaseName(base: string) {
  return base.replaceAll(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

function assertNoLPub3DWarnings(output: string, context: string) {
  const o = output || "";
  // Keep this conservative: only fail on strong signals that parts/files are missing.
  const bad = /(could not (open|locate)|file not found|missing (part|file)|cannot find (part|file))/i;
  if (bad.test(o)) {
    throw new Error(`LPub3D reported missing parts/files during ${context}. Output:\n${o.slice(0, 3000)}`);
  }
}

export function writeIdeaMpdToDisk(params: { baseName: string; ldrawMpd: string }) {
  const dir = path.join(process.cwd(), "data", "ldraw");
  ensureDir(dir);
  const base = safeBaseName(params.baseName);
  const mpdPath = path.join(dir, `${base}.mpd`);
  fs.writeFileSync(mpdPath, params.ldrawMpd, "utf8");
  return mpdPath;
}

export function generateThumbnailPngFromMpd(params: { mpdPath: string; baseName: string; size?: number }) {
  const bin = assertLPub3DAvailable();
  const outDir = path.join(process.cwd(), "public", "generated-thumbs");
  ensureDir(outDir);

  const base = safeBaseName(params.baseName);
  const outPath = path.join(outDir, `${base}.png`);

  const raw = fs.readFileSync(params.mpdPath, "utf8");
  const stepCount = countLDrawSteps(raw);
  const size = params.size ?? 1024;

  const args = [
    "--liblego",
    "-i",
    outPath,
    "-w",
    String(size),
    "-h",
    String(size),
    "--from",
    String(stepCount),
    "--to",
    String(stepCount),
    "--viewpoint",
    "home",
    params.mpdPath
  ];

  const res = spawnSync(bin, args, { encoding: "utf8" });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`LPub3D thumbnail generation failed (code ${res.status}). ${res.stderr || res.stdout || ""}`.trim());
  }
  assertNoLPub3DWarnings([res.stdout, res.stderr].filter(Boolean).join("\n"), "thumbnail render");
  if (!fs.existsSync(outPath)) {
    throw new Error("LPub3D thumbnail generation succeeded but output PNG was not created.");
  }

  return { url: `/generated-thumbs/${path.basename(outPath)}`, outPath };
}

export function generateInstructionsPdfFromMpd(params: { mpdPath: string; baseName: string; timeoutMs?: number }) {
  const bin = assertLPub3DAvailable();
  const outDir = path.join(process.cwd(), "public", "generated-instructions");
  ensureDir(outDir);

  const base = safeBaseName(params.baseName);
  const outPath = path.join(outDir, `${base}.pdf`);

  const args = ["--process-export", "--export-option", "pdf", "--output-file", outPath, "--liblego", params.mpdPath];
  const timeoutMs = params.timeoutMs || 120000; // 2 minutes default
  const res = spawnSync(bin, args, { encoding: "utf8", timeout: timeoutMs });
  
  if (res.error) {
    if ((res.error as any).code === "ETIMEDOUT") {
      throw new Error(`LPub3D PDF export timed out after ${timeoutMs}ms. The model may be too complex or LPub3D may have hung.`);
    }
    throw res.error;
  }
  
  if (res.status !== 0 && res.status !== null) {
    throw new Error(`LPub3D PDF export failed (code ${res.status}). ${res.stderr || res.stdout || ""}`.trim());
  }
  
  // If status is null, it was killed by timeout
  if (res.status === null) {
    throw new Error(`LPub3D PDF export did not complete. ${res.signal ? `Killed by signal: ${res.signal}` : "Process did not exit."}`);
  }
  
  assertNoLPub3DWarnings([res.stdout, res.stderr].filter(Boolean).join("\n"), "pdf export");
  if (!fs.existsSync(outPath)) {
    throw new Error("LPub3D PDF export succeeded but output PDF was not created.");
  }

  return { url: `/generated-instructions/${path.basename(outPath)}`, outPath };
}


