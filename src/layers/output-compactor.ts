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
  strategy: "passthrough" | "strip" | "truncate" | "semantic" | "summarize";
}

/**
 * Semantic Memory Unit — SimpleMem-inspired (2601.02553)
 * Multi-view indexed compact representation of unstructured output
 */
export interface SemanticUnit {
  key_facts: string[];     // extracted factual claims
  entities: string[];      // named entities (tools, files, APIs, people)
  actions: string[];       // actions taken or recommended
  numbers: string[];       // numeric data points with context
}

export class OutputCompactor {
  private stripThreshold: number;
  private truncateThreshold: number;
  private semanticThreshold: number;   // v1.3: semantic compress threshold
  private summarizeThreshold: number;
  private maxOutputTokens: number;

  constructor(opts?: {
    stripThreshold?: number;
    truncateThreshold?: number;
    semanticThreshold?: number;
    summarizeThreshold?: number;
    maxOutputTokens?: number;
  }) {
    this.stripThreshold = opts?.stripThreshold ?? 200;
    this.truncateThreshold = opts?.truncateThreshold ?? 500;
    this.semanticThreshold = opts?.semanticThreshold ?? 800;
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

    if (originalTokens <= this.semanticThreshold || !llmCall) {
      return { content: truncated, originalTokens, compactedTokens: truncatedTokens, strategy: "truncate" };
    }

    // v1.3: Semantic structured compression (SimpleMem-inspired)
    // Extract multi-view indexed units without LLM — pure regex extraction
    if (originalTokens <= this.summarizeThreshold) {
      const unit = this.extractSemanticUnit(stripped);
      const semantic = this.renderSemanticUnit(toolName, unit);
      const semanticTokens = this.estimateTokens(semantic);
      if (semanticTokens < truncatedTokens) {
        return { content: semantic, originalTokens, compactedTokens: semanticTokens, strategy: "semantic" };
      }
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

  /**
   * v1.3: Extract semantic memory unit from text (SimpleMem-inspired)
   * Pure regex — no LLM call needed
   */
  extractSemanticUnit(text: string): SemanticUnit {
    // Key facts: lines starting with bullet, numbered list, or containing "is", "are", "="
    const factPatterns = [
      /^[-*•]\s+(.{10,120})$/gm,
      /^\d+[.)]\s+(.{10,120})$/gm,
      /^(.{5,80}(?:is|are|was|were|=|：|是|为)\s*.{5,80})$/gm,
    ];
    const key_facts: string[] = [];
    for (const p of factPatterns) {
      let m;
      while ((m = p.exec(text)) !== null && key_facts.length < 10) {
        const fact = (m[1] || m[0]).trim();
        if (fact.length > 10 && !key_facts.includes(fact)) key_facts.push(fact);
      }
    }

    // Entities: file paths, URLs, tool names, API names, version numbers
    const entities: string[] = [];
    const entityPatterns = [
      /(?:\/[\w.-]+){2,}/g,                          // file paths
      /https?:\/\/[^\s)]+/g,                          // URLs
      /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g,            // CamelCase names
      /\bv?\d+\.\d+\.\d+\b/g,                         // version numbers
      /`([^`]{2,40})`/g,                               // inline code
    ];
    for (const p of entityPatterns) {
      let m;
      while ((m = p.exec(text)) !== null && entities.length < 8) {
        const ent = (m[1] || m[0]).trim();
        if (ent.length > 1 && !entities.includes(ent)) entities.push(ent);
      }
    }

    // Actions: imperative sentences, "run", "install", "create", etc.
    const actions: string[] = [];
    const actionPattern = /^(?:[-*•]\s+)?(?:run|install|create|update|delete|add|remove|set|configure|restart|deploy|build|test|check|open|close|执行|运行|安装|创建|更新|删除|配置|重启)\s+.{5,100}$/gim;
    let am;
    while ((am = actionPattern.exec(text)) !== null && actions.length < 5) {
      actions.push(am[0].replace(/^[-*•]\s+/, "").trim());
    }

    // Numbers: lines or phrases with numeric data
    const numbers: string[] = [];
    const numPattern = /(?:^|\n)([^\n]*\b\d+(?:\.\d+)?(?:\s*(?:%|ms|s|MB|GB|KB|tokens?|次|个|条|行|天|小时))\b[^\n]*)/g;
    let nm;
    while ((nm = numPattern.exec(text)) !== null && numbers.length < 5) {
      const num = nm[1].trim();
      if (num.length > 5 && num.length < 120) numbers.push(num);
    }

    return { key_facts, entities, actions, numbers };
  }

  /**
   * Render semantic unit as compact text
   */
  renderSemanticUnit(toolName: string, unit: SemanticUnit): string {
    const parts: string[] = [`[${toolName}]`];
    if (unit.key_facts.length > 0) parts.push(`Facts: ${unit.key_facts.join("; ")}`);
    if (unit.entities.length > 0) parts.push(`Entities: ${unit.entities.join(", ")}`);
    if (unit.actions.length > 0) parts.push(`Actions: ${unit.actions.join("; ")}`);
    if (unit.numbers.length > 0) parts.push(`Data: ${unit.numbers.join("; ")}`);
    return parts.join("\n");
  }

  private estimateTokens(text: string): number {
    const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
    const nonCjk = text.length - cjk;
    return Math.ceil(nonCjk / 4 + cjk / 2);
  }
}
