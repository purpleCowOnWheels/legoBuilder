#!/usr/bin/env npx tsx
/**
 * MCP Validation Log Viewer
 * 
 * Displays the validation progression from MCP sessions.
 * 
 * Usage:
 *   npx tsx mcp-server/view-logs.ts                    # Show latest session
 *   npx tsx mcp-server/view-logs.ts --list             # List all sessions
 *   npx tsx mcp-server/view-logs.ts <session-id>       # Show specific session
 *   npx tsx mcp-server/view-logs.ts --detailed         # Show full details
 *   npx tsx mcp-server/view-logs.ts --images           # List saved images
 */

import fs from "node:fs";
import path from "node:path";

const LOG_DIR = path.join(process.cwd(), "data", "mcp-logs");

interface LogEntry {
  sequence: number;
  timestamp: string;
  stage: "step" | "submodule" | "full";
  tool: string;
  input: Record<string, unknown>;
  result: {
    valid: boolean;
    checks_run: string[];
    checks_passed: number;
    checks_failed: number;
    checks: Array<{
      name: string;
      passed: boolean;
      score?: number;
      details: Record<string, unknown>;
      error?: string;
    }>;
    summary: string;
    recommendations?: string[];
  };
  images?: {
    render?: string;
    reference?: string;
  };
  duration_ms: number;
}

interface SessionData {
  session_id: string;
  started_at: string;
  entry_count: number;
  entries: LogEntry[];
}

// ANSI colors
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m"
};

function getStageColor(stage: string): string {
  switch (stage) {
    case "step": return colors.cyan;
    case "submodule": return colors.yellow;
    case "full": return colors.magenta;
    default: return colors.white;
  }
}

function getStatusBadge(valid: boolean): string {
  return valid 
    ? `${colors.bgGreen}${colors.white} PASS ${colors.reset}`
    : `${colors.bgRed}${colors.white} FAIL ${colors.reset}`;
}

function listSessions(): void {
  if (!fs.existsSync(LOG_DIR)) {
    console.log("No log directory found. Run some validations first.");
    return;
  }

  const sessions = fs.readdirSync(LOG_DIR)
    .filter(f => fs.statSync(path.join(LOG_DIR, f)).isDirectory())
    .sort()
    .reverse(); // Newest first

  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }

  console.log(`${colors.bold}Available Sessions:${colors.reset}\n`);
  
  for (const sessionId of sessions) {
    const sessionPath = path.join(LOG_DIR, sessionId, "session.json");
    if (fs.existsSync(sessionPath)) {
      const data = JSON.parse(fs.readFileSync(sessionPath, "utf8")) as SessionData;
      const entries = data.entries || [];
      const passed = entries.filter(e => e.result?.valid).length;
      const failed = entries.length - passed;
      
      console.log(
        `  ${colors.bold}${sessionId}${colors.reset} ` +
        `| ${entries.length} entries ` +
        `| ${colors.green}${passed} passed${colors.reset} ` +
        `| ${colors.red}${failed} failed${colors.reset}`
      );
    }
  }
  
  console.log(`\nUse: npx tsx mcp-server/view-logs.ts <session-id>`);
}

function viewSession(sessionId: string, detailed: boolean, showImages: boolean): void {
  const sessionDir = path.join(LOG_DIR, sessionId);
  const sessionPath = path.join(sessionDir, "session.json");
  
  if (!fs.existsSync(sessionPath)) {
    console.error(`Session not found: ${sessionId}`);
    return;
  }

  const data = JSON.parse(fs.readFileSync(sessionPath, "utf8")) as SessionData;
  const entries = data.entries || [];

  console.log("═".repeat(80));
  console.log(`${colors.bold}Session: ${data.session_id}${colors.reset}`);
  console.log(`Started: ${data.started_at}`);
  console.log(`Entries: ${entries.length}`);
  console.log("═".repeat(80));
  console.log();

  // Summary by stage
  const byStage = {
    step: entries.filter(e => e.stage === "step"),
    submodule: entries.filter(e => e.stage === "submodule"),
    full: entries.filter(e => e.stage === "full")
  };

  console.log(`${colors.bold}Summary by Stage:${colors.reset}`);
  for (const [stage, stageEntries] of Object.entries(byStage)) {
    if (stageEntries.length > 0) {
      const passed = stageEntries.filter(e => e.result?.valid).length;
      const color = getStageColor(stage);
      console.log(
        `  ${color}${stage.toUpperCase().padEnd(10)}${colors.reset} ` +
        `${stageEntries.length} validations | ` +
        `${colors.green}${passed} passed${colors.reset} | ` +
        `${colors.red}${stageEntries.length - passed} failed${colors.reset}`
      );
    }
  }
  console.log();

  // Progression timeline
  console.log(`${colors.bold}Validation Progression:${colors.reset}`);
  console.log("─".repeat(80));
  
  for (const entry of entries) {
    const stageColor = getStageColor(entry.stage);
    const statusBadge = getStatusBadge(entry.result?.valid ?? false);
    const time = new Date(entry.timestamp).toLocaleTimeString();
    
    console.log(
      `${colors.dim}#${entry.sequence.toString().padStart(3)}${colors.reset} ` +
      `${stageColor}[${entry.stage.toUpperCase().padEnd(9)}]${colors.reset} ` +
      `${statusBadge} ` +
      `${entry.tool} ` +
      `${colors.dim}(${entry.duration_ms}ms)${colors.reset}`
    );
    
    // Show checks summary
    if (entry.result?.checks) {
      const checkLine = entry.result.checks.map(c => 
        c.passed 
          ? `${colors.green}✓${c.name}${colors.reset}` 
          : `${colors.red}✗${c.name}${colors.reset}`
      ).join(" ");
      console.log(`     ${checkLine}`);
    }
    
    // Show recommendations if failed
    if (!entry.result?.valid && entry.result?.recommendations) {
      for (const rec of entry.result.recommendations) {
        console.log(`     ${colors.yellow}→ ${rec}${colors.reset}`);
      }
    }
    
    // Show images if present
    if (entry.images && showImages) {
      if (entry.images.render) {
        console.log(`     ${colors.dim}📷 Render: ${entry.images.render}${colors.reset}`);
      }
      if (entry.images.reference) {
        console.log(`     ${colors.dim}📷 Reference: ${entry.images.reference}${colors.reset}`);
      }
    }
    
    // Show detailed info
    if (detailed) {
      console.log(`     ${colors.dim}Input: ${JSON.stringify(entry.input).slice(0, 100)}...${colors.reset}`);
      if (entry.result?.summary) {
        console.log(`     ${colors.dim}Summary: ${entry.result.summary}${colors.reset}`);
      }
    }
    
    console.log();
  }

  // Show saved images
  if (showImages) {
    const imagesDir = path.join(sessionDir, "images");
    if (fs.existsSync(imagesDir)) {
      const images = fs.readdirSync(imagesDir).sort();
      if (images.length > 0) {
        console.log("─".repeat(80));
        console.log(`${colors.bold}Saved Images (${images.length}):${colors.reset}`);
        for (const img of images) {
          console.log(`  📷 ${img}`);
        }
        console.log(`\nImages dir: ${imagesDir}`);
      }
    }
  }

  // Final summary
  console.log("═".repeat(80));
  const totalPassed = entries.filter(e => e.result?.valid).length;
  const totalFailed = entries.length - totalPassed;
  const avgDuration = entries.length > 0 
    ? Math.round(entries.reduce((sum, e) => sum + e.duration_ms, 0) / entries.length)
    : 0;
  
  console.log(
    `${colors.bold}Total:${colors.reset} ${entries.length} validations | ` +
    `${colors.green}${totalPassed} passed${colors.reset} | ` +
    `${colors.red}${totalFailed} failed${colors.reset} | ` +
    `Avg: ${avgDuration}ms`
  );
  
  if (totalFailed > 0) {
    console.log(`\n${colors.yellow}Failed validations:${colors.reset}`);
    for (const entry of entries.filter(e => !e.result?.valid)) {
      console.log(`  #${entry.sequence} ${entry.stage}/${entry.tool}: ${entry.result?.summary || "Unknown error"}`);
    }
  }
}

function getLatestSession(): string | null {
  if (!fs.existsSync(LOG_DIR)) return null;
  
  const sessions = fs.readdirSync(LOG_DIR)
    .filter(f => fs.statSync(path.join(LOG_DIR, f)).isDirectory())
    .sort()
    .reverse();
  
  return sessions[0] || null;
}

// CLI
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
MCP Validation Log Viewer

Usage:
  npx tsx mcp-server/view-logs.ts                    # Show latest session
  npx tsx mcp-server/view-logs.ts --list             # List all sessions
  npx tsx mcp-server/view-logs.ts <session-id>       # Show specific session
  npx tsx mcp-server/view-logs.ts --detailed         # Show full details
  npx tsx mcp-server/view-logs.ts --images           # Show saved images

Options:
  --list       List all available sessions
  --detailed   Show detailed information for each entry
  --images     Show saved images
  --help       Show this help message
`);
  process.exit(0);
}

if (args.includes("--list")) {
  listSessions();
  process.exit(0);
}

const detailed = args.includes("--detailed");
const showImages = args.includes("--images");
const sessionArg = args.find(a => !a.startsWith("--"));

if (sessionArg) {
  viewSession(sessionArg, detailed, showImages);
} else {
  const latest = getLatestSession();
  if (latest) {
    console.log(`${colors.dim}Showing latest session: ${latest}${colors.reset}\n`);
    viewSession(latest, detailed, showImages);
  } else {
    console.log("No sessions found. Run some validations first.");
    console.log("Use --list to see all sessions.");
  }
}
