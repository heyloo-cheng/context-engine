/**
 * Context Assembler — Merge all layers into systemPrompt injection
 * Combines: Theme overview + User profile + Semantics + Episodes + Memories
 * Total budget: ~400-500 tokens
 */

import type { RetrievalResult, UserProfile } from "../types.js";

export class ContextAssembler {
  private tokenBudget: number;

  constructor(tokenBudget = 500) {
    this.tokenBudget = tokenBudget;
  }

  /**
   * Assemble context for systemPrompt injection
   */
  assemble(
    retrieval: RetrievalResult,
    profile: UserProfile | null
  ): string {
    const parts: string[] = [];
    let tokensUsed = 0;

    // 1. Theme overview (~50 tokens)
    if (retrieval.themes.length > 0) {
      const themeNames = retrieval.themes.map((t) => t.name).join(", ");
      const activeTheme = retrieval.themes[0]?.name || "general";
      const section = `## Active Context\nCurrent topic: ${activeTheme}\nRelated topics: ${themeNames}`;
      const tokens = this.estimateTokens(section);
      if (tokensUsed + tokens <= this.tokenBudget) {
        parts.push(section);
        tokensUsed += tokens;
      }
    }

    // 2. User profile (~100 tokens)
    if (profile?.global_profile) {
      const section = `## User Profile\n${profile.global_profile}`;
      const tokens = this.estimateTokens(section);
      if (tokensUsed + tokens <= this.tokenBudget) {
        parts.push(section);
        tokensUsed += tokens;
      }
    }

    // 3. Semantic facts (~150 tokens)
    if (retrieval.semantics.length > 0) {
      const facts = retrieval.semantics
        .map((s) => `- ${s.content}`)
        .join("\n");
      const section = `## Relevant Facts\n${facts}`;
      const tokens = this.estimateTokens(section);
      if (tokensUsed + tokens <= this.tokenBudget) {
        parts.push(section);
        tokensUsed += tokens;
      } else {
        // Truncate: add as many facts as budget allows
        const truncated: string[] = [];
        let t = this.estimateTokens("## Relevant Facts\n");
        for (const s of retrieval.semantics) {
          const line = `- ${s.content}`;
          const lt = this.estimateTokens(line);
          if (tokensUsed + t + lt > this.tokenBudget) break;
          truncated.push(line);
          t += lt;
        }
        if (truncated.length > 0) {
          parts.push(`## Relevant Facts\n${truncated.join("\n")}`);
          tokensUsed += t;
        }
      }
    }

    // 4. Episode details (only if Stage II expanded, ~200 tokens)
    if (retrieval.episodes.length > 0 && retrieval.stage2_decision !== "YES") {
      const details = retrieval.episodes
        .map((e) => `- ${e.summary}`)
        .join("\n");
      const section = `## Details\n${details}`;
      const tokens = this.estimateTokens(section);
      if (tokensUsed + tokens <= this.tokenBudget) {
        parts.push(section);
        tokensUsed += tokens;
      } else {
        // Truncate episodes
        const truncated: string[] = [];
        let t = this.estimateTokens("## Details\n");
        for (const e of retrieval.episodes) {
          const line = `- ${e.summary}`;
          const lt = this.estimateTokens(line);
          if (tokensUsed + t + lt > this.tokenBudget) break;
          truncated.push(line);
          t += lt;
        }
        if (truncated.length > 0) {
          parts.push(`## Details\n${truncated.join("\n")}`);
          tokensUsed += t;
        }
      }
    }

    if (parts.length === 0) return "";
    return parts.join("\n\n");
  }

  private estimateTokens(text: string): number {
    // Rough estimate: 1 token ≈ 4 chars for English, 2 chars for CJK
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
    const nonCjk = text.length - cjkCount;
    return Math.ceil(nonCjk / 4 + cjkCount / 2);
  }
}
