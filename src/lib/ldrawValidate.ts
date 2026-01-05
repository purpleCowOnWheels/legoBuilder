import { countLDrawSteps } from "@/lib/ldraw";

export function validateLDrawMpdOrThrow(params: { ldrawMpd: string; expectedParts?: number }) {
  const raw = params.ldrawMpd ?? "";
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("LDraw MPD is empty");
  }
  if (raw.includes("```")) {
    throw new Error("LDraw MPD contains code fences (```), which breaks LPub3D parsing");
  }

  const lines = raw.split(/\r?\n/);
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const last = nonEmpty[nonEmpty.length - 1] ?? "";

  // Strong signal that the model output was truncated mid-stream.
  if (!/^\s*0\s+NOFILE\s*$/i.test(last)) {
    throw new Error("LDraw MPD appears incomplete/truncated (missing required final line: `0 NOFILE`)");
  }

  const partLines = nonEmpty.filter((l) => /^\s*1\s+/.test(l)).length;
  const stepCount = countLDrawSteps(raw);

  // Heuristic checks: not perfect correctness, but catches the common failure mode (partial output).
  if (params.expectedParts != null && Number.isFinite(params.expectedParts) && params.expectedParts > 0) {
    const expected = Math.floor(params.expectedParts);
    // For small builds, don't force an arbitrary floor like 12.
    // For larger builds, require a reasonable fraction to detect truncation.
    const minParts =
      expected < 12 ? Math.max(1, Math.floor(expected * 0.6)) : Math.max(12, Math.floor(expected * 0.35));
    if (partLines < minParts) {
      throw new Error(
        `LDraw MPD looks incomplete: only ${partLines} part placements, expected roughly ${expected} (min acceptable ${minParts}).`
      );
    }
  } else {
    if (partLines < 12) throw new Error(`LDraw MPD looks incomplete: only ${partLines} part placements`);
  }

  const minSteps = params.expectedParts != null && params.expectedParts >= 50 ? 8 : 4;
  if (stepCount < minSteps) {
    throw new Error(`LDraw MPD has too few steps: ${stepCount} (expected at least ${minSteps})`);
  }
}


