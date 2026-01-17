#!/usr/bin/env tsx
/**
 * CLI tool to run the full LEGO build pipeline from an image + inventory.
 * 
 * Usage:
 *   ./node_modules/.bin/tsx scripts/run-build-pipeline.ts <image_path> [options]
 * 
 * Options:
 *   --inventory <path>     Path to inventory JSON file (default: uses db inventory)
 *   --prompt <text>        Build prompt/description (default: derived from image)
 *   --output <dir>         Output directory for renders (default: data/pipeline-output)
 *   --visual-feedback <mode>  "subassemblies" (default), "final_only", or "none"
 *   --no-tool-loop         Disable validation tool loop
 *   --render-steps         Render each step as it's generated
 *   --verbose              Show detailed output
 * 
 * Examples:
 *   tsx scripts/run-build-pipeline.ts ./my-reference.png --prompt "Build a robot"
 *   tsx scripts/run-build-pipeline.ts ./car.png --inventory ./inventory.json --render-steps
 */

import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";

// Load environment
dotenv.config({ path: path.join(process.cwd(), ".env.local") });

import { readDb } from "../src/lib/storage";
import { 
  generateBlueprintForIdea, 
  generateLDrawMpdChunkForIdea,
  type OpenAIValidateEvent,
  type VisualFeedbackMode
} from "../src/lib/openai";
import type { InventoryItem } from "../src/lib/models";

// ============================================================================
// CLI Argument Parsing
// ============================================================================

interface CliArgs {
  imagePath: string;
  inventoryPath?: string;
  prompt?: string;
  outputDir: string;
  visualFeedbackMode: VisualFeedbackMode;
  useToolLoop: boolean;
  renderSteps: boolean;
  verbose: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
LEGO Build Pipeline CLI

Usage:
  tsx scripts/run-build-pipeline.ts <image_path> [options]

Options:
  --inventory <path>         Path to inventory JSON file (default: uses db inventory)
  --prompt <text>            Build prompt/description (default: derived from filename)
  --output <dir>             Output directory for renders (default: data/pipeline-output)
  --visual-feedback <mode>   "subassemblies" (default), "final_only", or "none"
  --no-tool-loop             Disable validation tool loop
  --render-steps             Render each step as it's generated
  --verbose                  Show detailed output

Examples:
  tsx scripts/run-build-pipeline.ts ./my-reference.png --prompt "Build a robot"
  tsx scripts/run-build-pipeline.ts ./car.png --inventory ./inventory.json --render-steps
`);
    process.exit(0);
  }

  const result: CliArgs = {
    imagePath: args[0],
    outputDir: path.join(process.cwd(), "data", "pipeline-output"),
    visualFeedbackMode: "subassemblies",
    useToolLoop: true,
    renderSteps: false,
    verbose: false
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--inventory":
        result.inventoryPath = args[++i];
        break;
      case "--prompt":
        result.prompt = args[++i];
        break;
      case "--output":
        result.outputDir = args[++i];
        break;
      case "--visual-feedback":
        const mode = args[++i] as VisualFeedbackMode;
        if (!["subassemblies", "final_only", "none"].includes(mode)) {
          console.error(`Invalid visual-feedback mode: ${mode}`);
          process.exit(1);
        }
        result.visualFeedbackMode = mode;
        break;
      case "--no-tool-loop":
        result.useToolLoop = false;
        break;
      case "--render-steps":
        result.renderSteps = true;
        break;
      case "--verbose":
        result.verbose = true;
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        process.exit(1);
    }
  }

  return result;
}

// ============================================================================
// Rendering Utilities
// ============================================================================

function renderMpdToImage(params: {
  mpdContent: string;
  outputPath: string;
  stepNumber?: number;
  width?: number;
  height?: number;
}): boolean {
  const { mpdContent, outputPath, stepNumber, width = 512, height = 512 } = params;
  
  // Write MPD to temp file
  const tempDir = path.join(process.cwd(), "data", "pipeline-temp");
  fs.mkdirSync(tempDir, { recursive: true });
  const mpdPath = path.join(tempDir, `temp_${Date.now()}.mpd`);
  fs.writeFileSync(mpdPath, mpdContent, "utf8");
  
  // Count steps if not specified
  const stepMatches = mpdContent.match(/^\s*0\s+STEP\s*$/gim);
  const totalSteps = stepMatches ? stepMatches.length + 1 : 1;
  const targetStep = stepNumber ?? totalSteps;
  
  // Ensure output directory exists
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  
  // Try LPub3D first
  const lpub3dBin = process.env.LPUB3D_BIN || "/Applications/LPub3D.app/Contents/MacOS/LPub3D";
  
  if (fs.existsSync(lpub3dBin)) {
    const args = [
      "--liblego",
      "-i", outputPath,
      "-w", String(width),
      "-h", String(height),
      "--from", String(targetStep),
      "--to", String(targetStep),
      "--viewpoint", "home",
      mpdPath
    ];
    
    const res = spawnSync(lpub3dBin, args, { 
      encoding: "utf8", 
      timeout: 60000,
      cwd: tempDir
    });
    
    // Clean up temp file
    try { fs.unlinkSync(mpdPath); } catch {}
    
    if (fs.existsSync(outputPath)) {
      return true;
    }
    
    // Debug: log stderr if render failed
    if (res.stderr && res.stderr.length > 0) {
      console.warn("  [render] LPub3D stderr:", res.stderr.slice(0, 200));
    }
  }
  
  // Try LDView as fallback
  const ldviewBin = process.env.LDVIEW_BIN || "/Applications/LDView.app/Contents/MacOS/LDView";
  
  if (fs.existsSync(ldviewBin)) {
    const args = [
      mpdPath,
      `-SaveSnapshot=${outputPath}`,
      `-SaveWidth=${width}`,
      `-SaveHeight=${height}`,
      "-SaveAlpha=1"
    ];
    
    spawnSync(ldviewBin, args, { encoding: "utf8", timeout: 60000 });
    
    // Clean up temp file
    try { fs.unlinkSync(mpdPath); } catch {}
    
    if (fs.existsSync(outputPath)) {
      return true;
    }
  }
  
  // Clean up temp file
  try { fs.unlinkSync(mpdPath); } catch {}
  
  return false;
}

// ============================================================================
// Progress Display
// ============================================================================

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function createProgressLogger(verbose: boolean, runDir: string) {
  // Track similarity scores to show improvement trends
  const similarityHistory: Array<{ round: number; score: number; target: string }> = [];
  
  // Create validation images directory
  const validationImagesDir = path.join(runDir, "validation_images");
  if (!fs.existsSync(validationImagesDir)) {
    fs.mkdirSync(validationImagesDir, { recursive: true });
  }
  
  const getTrend = (currentScore: number, target: string): string => {
    // Find previous scores for the same target type
    const previousScores = similarityHistory
      .filter(h => h.target === target)
      .map(h => h.score);
    
    if (previousScores.length === 0) return "";
    
    const lastScore = previousScores[previousScores.length - 1];
    const diff = currentScore - lastScore;
    
    if (diff > 5) return ` 📈 +${diff}% (IMPROVING)`;
    if (diff > 0) return ` ↗️ +${diff}%`;
    if (diff < -5) return ` 📉 ${diff}% (REGRESSING!)`;
    if (diff < 0) return ` ↘️ ${diff}%`;
    return " → (no change)";
  };
  
  const getSummary = (): string => {
    if (similarityHistory.length < 2) return "";
    const scores = similarityHistory.map(h => h.score);
    const first = scores[0];
    const last = scores[scores.length - 1];
    const max = Math.max(...scores);
    const min = Math.min(...scores);
    return `\n    📊 Similarity trend: ${first}% → ${last}% (range: ${min}%-${max}%, ${similarityHistory.length} measurements)`;
  };
  
  return {
    section: (title: string) => {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`  ${title}`);
      console.log("=".repeat(60));
    },
    step: (msg: string) => console.log(`\n▶ ${msg}`),
    info: (msg: string) => console.log(`  ${msg}`),
    success: (msg: string) => console.log(`  ✅ ${msg}`),
    warning: (msg: string) => console.log(`  ⚠️  ${msg}`),
    error: (msg: string) => console.error(`  ❌ ${msg}`),
    debug: (msg: string) => verbose && console.log(`  [debug] ${msg}`),
    getSimilaritySummary: getSummary,
    resetSimilarityTracking: () => { similarityHistory.length = 0; },
    event: (evt: OpenAIValidateEvent) => {
      // Helper to format validation target nicely
      const formatTarget = (target?: string, mode?: string) => {
        switch (target) {
          case "chunk": return "CHUNK (structure only)";
          case "partial_build": return "PARTIAL BUILD";
          case "subassembly": return "SUBASSEMBLY COMPLETE";
          case "final_model": return "FINAL MODEL";
          default: return mode ? `mode=${mode}` : "unknown";
        }
      };
      
      switch (evt.type) {
        case "round_start":
          console.log(`    📍 Validation round ${evt.round} starting...`);
          break;
        case "api_response":
          if (verbose && evt.usage) {
            console.log(`    📊 Tokens: in=${evt.usage.input_tokens}, out=${evt.usage.output_tokens}, reasoning=${evt.usage.reasoning_tokens || 0}`);
          }
          break;
        case "tool_calls":
          for (const c of evt.calls) {
            const target = formatTarget(c.validation_target, c.mode);
            const steps = c.step_range ? ` [steps ${c.step_range.from || "?"}-${c.step_range.to || "?"}]` : "";
            console.log(`    🔧 Validating: ${target}${steps}`);
          }
          break;
        case "tool_results":
          for (const r of evt.results) {
            const targetKey = r.validation_target || "unknown";
            const target = formatTarget(r.validation_target);
            
            // Track similarity if render was compared
            let trend = "";
            if (r.render_compared && r.similarity_score !== undefined) {
              trend = getTrend(r.similarity_score, targetKey);
              similarityHistory.push({ 
                round: evt.round, 
                score: r.similarity_score, 
                target: targetKey 
              });
            }
            
            const renderInfo = r.render_compared 
              ? ` (similarity: ${r.similarity_score}%${trend})` 
              : " (structure only, no render)";
            
            // Add piece count info if available
            const pieceInfo = r.pieces_total !== undefined
              ? ` [+${r.pieces_in_chunk || 0} pieces, ${r.pieces_total} total]`
              : "";
            
            if (r.ok) {
              console.log(`    ✓ ${target}: PASSED${renderInfo}${pieceInfo}`);
            } else {
              console.log(`    ✗ ${target}: FAILED${renderInfo}${pieceInfo}`);
              console.log(`      Error: ${r.error}`);
              if (r.issues && verbose) {
                for (const issue of r.issues.slice(0, 3)) {
                  console.log(`      - ${issue.type}: ${issue.message}`);
                }
              }
            }
          }
          break;
        case "visual_feedback_sent":
          const triggerLabel = evt.trigger === "final_validation" 
            ? "📸 FINAL MODEL rendered" 
            : "📸 SUBASSEMBLY rendered";
          console.log(`    🖼️  ${triggerLabel} - sending ${evt.image_count} image(s) to GPT for visual review`);
          
          // Copy images from debug folder to pipeline output
          if (evt.image_paths && evt.image_paths.length > 0) {
            for (const imgPath of evt.image_paths) {
              if (fs.existsSync(imgPath)) {
                const basename = path.basename(imgPath);
                const destPath = path.join(validationImagesDir, basename);
                try {
                  fs.copyFileSync(imgPath, destPath);
                  if (verbose) {
                    console.log(`      💾 Saved: ${path.relative(runDir, destPath)}`);
                  }
                } catch (e) {
                  console.warn(`      ⚠️  Failed to copy image: ${e instanceof Error ? e.message : "unknown error"}`);
                }
              }
            }
          }
          break;
        case "round_done":
          console.log(`    📍 Round ${evt.round} complete`);
          // Show similarity summary after each round if we have data
          if (similarityHistory.length >= 2) {
            console.log(getSummary());
          }
          break;
      }
    }
  };
}

// ============================================================================
// Main Pipeline
// ============================================================================

async function runPipeline(args: CliArgs) {
  const startTime = performance.now();
  
  // Validate inputs
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Input Validation`);
  console.log("=".repeat(60));
  
  if (!fs.existsSync(args.imagePath)) {
    console.error(`  ❌ Image not found: ${args.imagePath}`);
    process.exit(1);
  }
  console.log(`  Reference image: ${args.imagePath}`);
  
  // Load inventory
  let inventory: InventoryItem[];
  if (args.inventoryPath) {
    if (!fs.existsSync(args.inventoryPath)) {
      console.error(`  ❌ Inventory file not found: ${args.inventoryPath}`);
      process.exit(1);
    }
    const raw = fs.readFileSync(args.inventoryPath, "utf8");
    const parsed = JSON.parse(raw);
    // Support both direct array and { inventory: [...] } format
    inventory = Array.isArray(parsed) ? parsed : (parsed.inventory || []);
    console.log(`  Loaded inventory from: ${args.inventoryPath} (${inventory.length} items)`);
  } else {
    const db = readDb();
    inventory = db.inventory || [];
    console.log(`  Using database inventory (${inventory.length} items)`);
  }
  
  if (inventory.length === 0) {
    console.error("  ❌ Inventory is empty!");
    process.exit(1);
  }
  
  // Get/generate prompt
  const prompt = args.prompt || path.basename(args.imagePath, path.extname(args.imagePath)).replace(/[-_]/g, " ");
  console.log(`  Build prompt: "${prompt}"`);
  
  // Setup output directory
  fs.mkdirSync(args.outputDir, { recursive: true });
  const runId = `run_${Date.now()}`;
  const runDir = path.join(args.outputDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  console.log(`  Output directory: ${runDir}`);
  
  // Now create logger with runDir
  const log = createProgressLogger(args.verbose, runDir);
  
  // Copy reference image to output
  const refImageDest = path.join(runDir, "00_reference.png");
  fs.copyFileSync(args.imagePath, refImageDest);
  
  log.info(`Visual feedback mode: ${args.visualFeedbackMode}`);
  log.info(`Tool loop: ${args.useToolLoop ? "enabled" : "disabled"}`);
  log.info(`Render steps: ${args.renderSteps ? "enabled" : "disabled"}`);
  
  // =========================================================================
  // Phase 1: Generate Blueprint from Image
  // =========================================================================
  log.section("Phase 1: Generate Blueprint from Image");
  log.step("Generating build blueprint from image...");
  
  const blueprintStart = performance.now();
  const { blueprint, model: blueprintModel } = await generateBlueprintForIdea({
    inventory,
    constraintsText: "Build something interesting with the available parts.",
    referenceImagePath: args.imagePath
  });
  
  log.success(`Blueprint generated (${formatDuration(performance.now() - blueprintStart)})`);
  log.info(`Model: ${blueprintModel}`);
  log.info(`Blueprint overview: "${blueprint.structure_plan.overview.slice(0, 100)}..."`);
  log.info(`Subassemblies: ${blueprint.structure_plan.subassemblies.map(s => s.name).join(", ")}`);
  log.info(`Total steps: ${blueprint.step_outline.length}`);
  
  // Save blueprint
  const blueprintPath = path.join(runDir, "01_blueprint.json");
  fs.writeFileSync(blueprintPath, JSON.stringify(blueprint, null, 2), "utf8");
  log.debug(`Blueprint saved to: ${blueprintPath}`);
  
  // Show step outline
  if (args.verbose) {
    log.info("Step outline:");
    for (const step of blueprint.step_outline) {
      log.debug(`  ${step.step}. ${step.title}`);
    }
  }
  
  // =========================================================================
  // Phase 3: Generate LDraw Chunks
  // =========================================================================
  log.section("Phase 3: Generate LDraw Chunks");
  
  const totalSteps = blueprint.step_outline.length;
  // Chunk size: aim for 25-50 pieces per chunk
  // With max 5 parts/step, need 5-10 steps/chunk
  // Use 8 steps/chunk as a good balance (allows ~40 pieces/chunk)
  const chunkSize = 8; // Steps per chunk
  const chunks: string[] = [];
  let assembledMpd = "";
  
  // Calculate total number of chunks upfront
  const totalChunks = Math.ceil(totalSteps / chunkSize);
  log.info(`Total chunks to generate: ${totalChunks} (${totalSteps} steps, ${chunkSize} steps/chunk, target ~${chunkSize * 5} pieces/chunk)`);
  
  // Track which subassemblies we've completed
  const completedSubassemblies = new Set<string>();
  
  for (let stepFrom = 1; stepFrom <= totalSteps; stepFrom += chunkSize) {
    const stepTo = Math.min(stepFrom + chunkSize - 1, totalSteps);
    const chunkIndex = Math.floor((stepFrom - 1) / chunkSize) + 1;
    const isFinalChunk = stepTo >= totalSteps;
    
    // Determine current subassembly
    const currentStepOutline = blueprint.step_outline.find(s => s.step === stepTo);
    const currentSubassembly = currentStepOutline?.title?.split(" ")[0] || undefined;
    
    // Check if this completes a subassembly
    const nextStepOutline = blueprint.step_outline.find(s => s.step === stepTo + 1);
    const nextSubassembly = nextStepOutline?.title?.split(" ")[0];
    const isSubassemblyBoundary = currentSubassembly && (
      isFinalChunk || 
      (nextSubassembly && nextSubassembly !== currentSubassembly && !completedSubassemblies.has(currentSubassembly))
    );
    
    if (isSubassemblyBoundary && currentSubassembly) {
      completedSubassemblies.add(currentSubassembly);
    }
    
    log.step(`Generating chunk ${chunkIndex} (steps ${stepFrom}-${stepTo})${isSubassemblyBoundary ? " [subassembly boundary]" : ""}${isFinalChunk ? " [FINAL]" : ""}`);
    
    // Reset similarity tracking for each chunk
    log.resetSimilarityTracking();
    
    const chunkStart = performance.now();
    
    try {
      const { chunkBody, model: chunkModel } = await generateLDrawMpdChunkForIdea({
        title,
        userPrompt: prompt,
        inventory,
        blueprint,
        stepFrom,
        stepTo,
        assembledMpdSoFar: assembledMpd ? `0 FILE model.ldr\n${assembledMpd}\n0 NOFILE` : undefined,
        useValidationToolLoop: args.useToolLoop,
        onEvent: log.event,
        // NOTE: Do NOT send image for chunk generation - blueprint already has the plan
        // Only use image for visual validation feedback if enabled
        referenceImagePath: args.useToolLoop ? args.imagePath : undefined,
        minSimilarity: 50,
        currentSubassembly,
        visualFeedbackMode: args.visualFeedbackMode,
        isSubassemblyBoundary: isSubassemblyBoundary || false,
        isFinalChunk,
        currentChunkNumber: chunkIndex,
        totalChunks
      });
      
      chunks.push(chunkBody);
      assembledMpd = assembledMpd ? `${assembledMpd}\n${chunkBody}` : chunkBody;
      
      log.success(`Chunk ${chunkIndex} complete (${formatDuration(performance.now() - chunkStart)})`);
      // Show final similarity summary for this chunk
      const similaritySummary = log.getSimilaritySummary();
      if (similaritySummary) {
        console.log(similaritySummary);
      }
      log.debug(`Model: ${chunkModel}, chunk size: ${chunkBody.length} chars`);
      
      // Save chunk
      const chunkPath = path.join(runDir, `02_chunk_${String(chunkIndex).padStart(2, "0")}_steps_${stepFrom}-${stepTo}.ldr`);
      fs.writeFileSync(chunkPath, chunkBody, "utf8");
      
      // Render this step if requested
      if (args.renderSteps) {
        const stepRenderPath = path.join(runDir, `03_render_step_${String(stepTo).padStart(2, "0")}.png`);
        const fullMpd = `0 FILE model.ldr\n${assembledMpd}\n0 NOFILE`;
        
        log.info("Rendering current state...");
        const rendered = renderMpdToImage({
          mpdContent: fullMpd,
          outputPath: stepRenderPath
        });
        
        if (rendered) {
          log.success(`Rendered to: ${stepRenderPath}`);
        } else {
          log.warning("Render failed (LPub3D/LDView not available)");
        }
      }
      
    } catch (err) {
      log.error(`Chunk ${chunkIndex} failed: ${err instanceof Error ? err.message : String(err)}`);
      
      // Show final similarity summary for this chunk (even on failure)
      const similaritySummary = log.getSimilaritySummary();
      if (similaritySummary) {
        console.log(`\n    📊 SIMILARITY TRACKING FOR FAILED CHUNK:${similaritySummary}`);
      }
      
      // Save partial progress
      if (assembledMpd) {
        const partialPath = path.join(runDir, "PARTIAL_mpd.ldr");
        fs.writeFileSync(partialPath, `0 FILE model.ldr\n${assembledMpd}\n0 NOFILE`, "utf8");
        log.warning(`Partial MPD saved to: ${partialPath}`);
      }
      
      process.exit(1);
    }
  }
  
  // =========================================================================
  // Phase 4: Final Assembly & Render
  // =========================================================================
  log.section("Phase 4: Final Assembly");
  
  const finalMpd = `0 FILE model.ldr
0 ${title}
0 Author: LEGO Builder Pipeline
0 !LDRAW_ORG Model

${assembledMpd}
0 NOFILE`;
  
  const finalMpdPath = path.join(runDir, "04_final.mpd");
  fs.writeFileSync(finalMpdPath, finalMpd, "utf8");
  log.success(`Final MPD saved: ${finalMpdPath}`);
  
  // Count parts
  const partLines = finalMpd.split("\n").filter(l => /^\s*1\s+/.test(l));
  log.info(`Total parts: ${partLines.length}`);
  
  // Final render
  log.step("Rendering final model...");
  const finalRenderPath = path.join(runDir, "05_final_render.png");
  const rendered = renderMpdToImage({
    mpdContent: finalMpd,
    outputPath: finalRenderPath,
    width: 1024,
    height: 1024
  });
  
  if (rendered) {
    log.success(`Final render: ${finalRenderPath}`);
  } else {
    log.warning("Final render failed (LPub3D/LDView not available)");
  }
  
  // =========================================================================
  // Summary
  // =========================================================================
  log.section("Pipeline Complete");
  
  const totalDuration = performance.now() - startTime;
  
  console.log(`
  Title:           ${title}
  Total Steps:     ${totalSteps}
  Total Parts:     ${partLines.length}
  Chunks:          ${chunks.length}
  Duration:        ${formatDuration(totalDuration)}
  
  Output Files:
    ${runDir}/
    ├── 00_reference.png       (input image)
    ├── 01_blueprint.json      (build plan)
    ├── 02_chunk_*.ldr         (LDraw chunks)
    ${args.renderSteps ? "├── 03_render_step_*.png   (step renders)\n    " : ""}├── 04_final.mpd           (complete model)
    └── 05_final_render.png    (final render)
`);
  
  log.success(`Done in ${formatDuration(totalDuration)}!`);
}

// ============================================================================
// Entry Point
// ============================================================================

const args = parseArgs();
runPipeline(args).catch((err) => {
  console.error("\n❌ Pipeline failed:", err);
  process.exit(1);
});
