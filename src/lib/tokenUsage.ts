/**
 * Token usage tracking and cost estimation for OpenAI API calls
 * 
 * Pricing as of Jan 2026 (update if changed):
 * - GPT-4o: $2.50/1M input, $10/1M output
 * - GPT-4o-mini: $0.15/1M input, $0.60/1M output
 * - o1: $15/1M input, $60/1M output
 * - o1-mini: $3/1M input, $12/1M output
 * - o3-mini: $1.10/1M input, $4.40/1M output
 */

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;
  total_tokens: number;
}

export interface UsageEntry {
  timestamp: string;
  operation: string;
  model: string;
  usage: TokenUsage;
  cost_usd: number;
  duration_ms?: number;
}

export interface UsageSummary {
  total_input_tokens: number;
  total_output_tokens: number;
  total_reasoning_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  entries: UsageEntry[];
  by_operation: Record<string, {
    count: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  }>;
}

// Pricing per 1M tokens (update these if OpenAI changes pricing)
const PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.50, output: 10.00 },
  "gpt-4o-2024-11-20": { input: 2.50, output: 10.00 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4o-mini-2024-07-18": { input: 0.15, output: 0.60 },
  "o1": { input: 15.00, output: 60.00 },
  "o1-2024-12-17": { input: 15.00, output: 60.00 },
  "o1-mini": { input: 3.00, output: 12.00 },
  "o1-mini-2024-09-12": { input: 3.00, output: 12.00 },
  "o3-mini": { input: 1.10, output: 4.40 },
  "o3-mini-2025-01-31": { input: 1.10, output: 4.40 },
};

// Default pricing for unknown models
const DEFAULT_PRICING = { input: 5.00, output: 15.00 };

/**
 * Calculate cost for a single API call
 */
export function calculateCost(model: string, usage: TokenUsage): number {
  const pricing = PRICING[model] || PRICING[model.split("-").slice(0, 2).join("-")] || DEFAULT_PRICING;
  const inputCost = (usage.input_tokens / 1_000_000) * pricing.input;
  const outputCost = (usage.output_tokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

/**
 * Token usage tracker - accumulates usage across multiple API calls
 */
export class TokenTracker {
  private entries: UsageEntry[] = [];
  
  /**
   * Record a new API call
   */
  record(params: {
    operation: string;
    model: string;
    usage: Partial<TokenUsage>;
    duration_ms?: number;
  }): UsageEntry {
    const usage: TokenUsage = {
      input_tokens: params.usage.input_tokens || 0,
      output_tokens: params.usage.output_tokens || 0,
      reasoning_tokens: params.usage.reasoning_tokens,
      total_tokens: params.usage.total_tokens || 
        (params.usage.input_tokens || 0) + (params.usage.output_tokens || 0)
    };
    
    const cost_usd = calculateCost(params.model, usage);
    
    const entry: UsageEntry = {
      timestamp: new Date().toISOString(),
      operation: params.operation,
      model: params.model,
      usage,
      cost_usd,
      duration_ms: params.duration_ms
    };
    
    this.entries.push(entry);
    return entry;
  }
  
  /**
   * Get summary of all recorded usage
   */
  getSummary(): UsageSummary {
    const byOperation: UsageSummary["by_operation"] = {};
    
    let total_input = 0;
    let total_output = 0;
    let total_reasoning = 0;
    let total_cost = 0;
    
    for (const entry of this.entries) {
      total_input += entry.usage.input_tokens;
      total_output += entry.usage.output_tokens;
      total_reasoning += entry.usage.reasoning_tokens || 0;
      total_cost += entry.cost_usd;
      
      if (!byOperation[entry.operation]) {
        byOperation[entry.operation] = {
          count: 0,
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0
        };
      }
      byOperation[entry.operation].count++;
      byOperation[entry.operation].input_tokens += entry.usage.input_tokens;
      byOperation[entry.operation].output_tokens += entry.usage.output_tokens;
      byOperation[entry.operation].cost_usd += entry.cost_usd;
    }
    
    return {
      total_input_tokens: total_input,
      total_output_tokens: total_output,
      total_reasoning_tokens: total_reasoning,
      total_tokens: total_input + total_output,
      total_cost_usd: total_cost,
      entries: this.entries,
      by_operation: byOperation
    };
  }
  
  /**
   * Get a formatted summary string
   */
  getFormattedSummary(): string {
    const summary = this.getSummary();
    const lines: string[] = [
      "═".repeat(60),
      "TOKEN USAGE SUMMARY",
      "═".repeat(60),
      "",
      `Total Tokens:    ${summary.total_tokens.toLocaleString()}`,
      `  Input:         ${summary.total_input_tokens.toLocaleString()}`,
      `  Output:        ${summary.total_output_tokens.toLocaleString()}`,
    ];
    
    if (summary.total_reasoning_tokens > 0) {
      lines.push(`  Reasoning:     ${summary.total_reasoning_tokens.toLocaleString()}`);
    }
    
    lines.push(
      "",
      `Estimated Cost:  $${summary.total_cost_usd.toFixed(4)}`,
      "",
      "─".repeat(60),
      "BY OPERATION:",
      "─".repeat(60)
    );
    
    for (const [op, data] of Object.entries(summary.by_operation)) {
      lines.push(
        `  ${op}:`,
        `    Calls: ${data.count}  |  Tokens: ${(data.input_tokens + data.output_tokens).toLocaleString()}  |  Cost: $${data.cost_usd.toFixed(4)}`
      );
    }
    
    lines.push("═".repeat(60));
    
    return lines.join("\n");
  }
  
  /**
   * Reset the tracker
   */
  reset(): void {
    this.entries = [];
  }
  
  /**
   * Get entries
   */
  getEntries(): UsageEntry[] {
    return [...this.entries];
  }
}

/**
 * Global tracker instance for convenience
 */
let globalTracker: TokenTracker | null = null;

export function getGlobalTracker(): TokenTracker {
  if (!globalTracker) {
    globalTracker = new TokenTracker();
  }
  return globalTracker;
}

export function resetGlobalTracker(): void {
  globalTracker = new TokenTracker();
}

/**
 * Format a single usage entry for logging
 */
export function formatUsageEntry(entry: UsageEntry): string {
  const tokens = `${entry.usage.input_tokens.toLocaleString()} in / ${entry.usage.output_tokens.toLocaleString()} out`;
  const cost = `$${entry.cost_usd.toFixed(4)}`;
  const duration = entry.duration_ms ? ` (${entry.duration_ms}ms)` : "";
  return `[${entry.operation}] ${tokens} = ${cost}${duration}`;
}
