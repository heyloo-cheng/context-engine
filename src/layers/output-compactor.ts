/**
 * Output Compactor — Compress tool outputs to save tokens
 * 
 * Strategies:
 * 1. Strip noise (HTML tags, repeated headers, whitespace)
 * 2. Truncate long outputs with smart boundaries
 * 3. LLM summarize only when output > threshold
 */

export interface CompactResult {
  content: string;
  originalTokens: number;
  compactedTokens: number;
  strategy: "passthrough" | "strip" | "truncate" | "summarize";
}

export class OutputCompactor {
  private stripThreshold: number;   // tokens above this → strip noise
  private truncateThreshold: number; // tokens above this → truncate
  private summarizeThreshold: number; // tokens above this → LLM summarize
  private maxOutputTokens: number;

  constructor(opts?: {
    stripThreshold?: number;
    truncateThreshold?: number;
    summarizeThreshold?: number;
    maxOutputTokens?: number;
  }) {
    this.stripThreshold = opts?.stripThreshold ?? 200;
    this.truncateThreshold = opts?.truncateThreshold ?? 500;
    this.summarizeThreshold = opts?.summarizeThreshold ?? 1500;
    this.maxOutputTokens = opts?.maxOutputTokens ?? 400;
  }

  /**
   * Compact a tool output
   */
  async compact(
    toolName: string,
    output: string,
    llmCall?: (prompt: string) => Promise<string>
  ): Promise<CompactResult> {
    const originalTokens = this.estimateTokens(output);

    // Small output → passthrough
    if (originalTokens <= this.stripThreshold) {
      return { content: output, originalTokens, compactedTokens: originalTokens, strategy: "passthrough" };
    }

    // Medium output → strip noise
    let stripped = this.stripNoise(output);
    let strippedTokens = this.estimateTokens(stripped);

    if (strippedTokens <= this.truncateThreshold) {
      return { content: stripped, originalTokens, compactedTokens: strippedTokens, strategy: "strip" };
    }

    // Large output → truncate smartly
    const truncated = this.smartTruncate(stripped, this.maxOutputTokens);
    const truncatedTokens = this.estimateTokens(truncated);

    if (originalTokens <= this.summarizeThreshold || !llmCall) {
      return { content: truncated, originalTokens, compactedTokens: truncatedTokens, strategy: "truncate" };
    }

    // Very large output → LLM summarize
    try {
      const summary = await this.llmSummarize(toolName, stripped, llmCall);
      const summaryTokens = this.estimateTokens(summary);
      return { content: summary, originalTokens, compactedTokens: summaryTokens, strategy: "summarize" };
    } catch {
      // Fallback to truncation
      return { content: truncated, originalTokens, compactedTokens: truncatedTokens, strategy: "truncate" };
    }
  }

  /**
   * Strip noise: HTML tags, excessive whitespace, repeated patterns
   */
  private stripNoise(text: string): string {
    let result = text;

    // Remove HTML tags
    result = result.replace(/<[^>]+>/g, "");

    // Remove markdown image syntax
    result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, "[$1]");

    // Collapse multiple blank lines → single
    result = result.replace(/\n{3,}/g, "\n\n");

    // Collapse multiple spaces → single
    result = result.replace(/ {2,}/g, " ");

    // Remove common noise patterns from web_fetch
    result = result.replace(/^(Share|Tweet|Pin|Email|Print|Subscribe|Sign in|Sign up|Loading|Advertisement)\s*$/gm, "");

    // Remove navigation breadcrumbs
    result = result.replace(/^(Home|Blog|About|Contact|Menu|Navigation)\s*[>|/→]\s*.+$/gm, "");

    // Trim each line
    result = result.split("\n").map(l => l.trim()).join("\n");

    // Final trim
    return result.trim();
  }

  /**
   * Smart truncate: cut at sentence/paragraph boundaries
   */
  private smartTruncate(text: string, maxTokens: number): string {
    const lines = text.split("\n");
    const result: string[] = [];
    let tokens = 0;

    for (const line of lines) {
      const lineTokens = this.estimateTokens(line);
      if (tokens + lineTokens > maxTokens) {
        // Try to cut at sentence boundary within this line
        if (result.length === 0) {
          // First line is already too long, cut at sentence
          const sentences = line.match(/[^.!?。！？]+[.!?。！？]+/g) || [line];
          for (const s of sentences) {
            const st = this.estimateTokens(s);
            if (tokens + st > maxTokens) break;
            result.push(s);
            tokens += st;
          }
        }
        result.push(`\n... [truncated, ${this.estimateTokens(text) - tokens} tokens omitted]`);
        break;
      }
      result.push(line);
      tokens += lineTokens;
    }

    return result.join("\n");
  }

  /**
   * LLM summarize for very large outputs
   */
  private async llmSummarize(
    toolName: string,
    output: string,
    llmCall: (prompt: string) => Promise<string>
  ): Promise<string> {
    // Take first 3000 chars + last 1000 chars for context
    const head = output.slice(0, 3000);
    const tail = output.length > 4000 ? `\n...\n${output.slice(-1000)}` : "";

    const prompt = `Summarize this ${toolName} output in <200 tokens. Keep key data (numbers, names, paths, errors). Skip formatting noise.\n\nOutput:\n${head}${tail}`;

    const summary = await llmCall(prompt);
    return summary || this.smartTruncate(output, this.maxOutputTokens);
  }

  private estimateTokens(text: string): number {
    const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
    const nonCjk = text.length - cjk;
    return Math.ceil(nonCjk / 4 + cjk / 2);
  }
}
