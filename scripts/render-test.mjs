import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ldrawContent = `0 FILE model.ldr
0 Rough build based on provided render
0 Author: ChatGPT
0 !LDRAW_ORG Model
0 !LICENSE Redistributable under CCAL version 2.0 : see CAreadme.txt

0 STEP
0 // Feet (two 2x2 slopes)
1 72 -20 -24  20  1 0 0  0 1 0  0 0 1  3039.dat
1 72  20 -24  20  1 0 0  0 1 0  0 0 1  3039.dat

0 STEP
0 // Bottom base brick (2x4)
1 71   0   0   0  1 0 0  0 1 0  0 0 1  3001.dat

0 STEP
0 // Dark plate "stripe" (2x4 plate)
1 72   0  24   0  1 0 0  0 1 0  0 0 1  3020.dat

0 STEP
0 // Middle base brick (2x4)
1 71   0  32   0  1 0 0  0 1 0  0 0 1  3001.dat

0 STEP
0 // Top dark plate "stripe" (2x4 plate)
1 72   0  56   0  1 0 0  0 1 0  0 0 1  3020.dat

0 STEP
0 // Column base (2x2 brick)
1 72   0  64   0  1 0 0  0 1 0  0 0 1  3003.dat

0 STEP
0 // Column (stacked 1x1 round bricks / rings vibe)
1 72   0  88   0  1 0 0  0 1 0  0 0 1  3062b.dat
1 72   0 112   0  1 0 0  0 1 0  0 0 1  3062b.dat
1 72   0 136   0  1 0 0  0 1 0  0 0 1  3062b.dat

0 STEP
0 // "Camera" head: 1x1 brick with side stud + top cap + red side plate + small round "lens"
0 // Brick, Modified 1 x 1 with Studs on 1 Side (stud faces +X)
1 72   0 160   0  0 0 -1  0 1 0  1 0 0  87087.dat
0 // Top cap (1x1 plate)
1 72   0 184   0  1 0 0  0 1 0  0 0 1  3024.dat
0 // Red "arm" (1x2 plate) attached to side-stud area (approx position)
1  4  20 160   0  1 0 0  0 1 0  0 0 1  3023.dat
0 // Small round tile as "lens" on the front face (approx position)
1  0 -10 160  10  1 0 0  0 1 0  0 0 1  98138.dat

0 NOFILE
`;

// Write the MPD file
const mpdDir = path.join(process.cwd(), "data", "ldraw");
fs.mkdirSync(mpdDir, { recursive: true });
const mpdPath = path.join(mpdDir, "test_render_model.mpd");
fs.writeFileSync(mpdPath, ldrawContent, "utf8");
console.log("Wrote MPD file to:", mpdPath);

// Count steps
const stepMatches = ldrawContent.match(/^\s*0\s+STEP\s*$/gim);
const stepCount = stepMatches ? stepMatches.length + 1 : 1;
console.log("Step count:", stepCount);

// Generate thumbnail
const bin = process.env.LPUB3D_BIN || "/Applications/LPub3D.app/Contents/MacOS/LPub3D";
if (!fs.existsSync(bin)) {
  console.error("LPub3D not found at:", bin);
  process.exit(1);
}

const outDir = path.join(process.cwd(), "public", "generated-thumbs");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "test_render_model.png");

const args = [
  "--liblego",
  "-i", outPath,
  "-w", "1024",
  "-h", "1024",
  "--from", String(stepCount),
  "--to", String(stepCount),
  "--viewpoint", "home",
  mpdPath
];

console.log("Running LPub3D with args:", args.join(" "));
const res = spawnSync(bin, args, { encoding: "utf8", stdio: "inherit" });

if (res.error) {
  console.error("Error:", res.error);
  process.exit(1);
}

if (fs.existsSync(outPath)) {
  console.log("\n✅ Thumbnail generated successfully!");
  console.log("Output:", outPath);
  console.log("URL: /generated-thumbs/test_render_model.png");
} else {
  console.error("❌ Output file was not created");
}

