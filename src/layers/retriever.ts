/**
 * Top-Down Retriever — xMemory two-stage retrieval
 * Stage I: Select themes + semantics (breadth)
 * Stage II: Expand to episodes + messages (depth, uncertainty-gated)
 */

import type { Theme, Semantic, Episode, RetrievalResult, RetrievalTrace } from "../types.js";
import { cosineSimilarity } from "../utils/embedding.js";
import type { StorageLayer } from "./storage.js";

export class TopDownRetriever {
  private storage: StorageLayer;
  private tokenBudget: number;

  constructor(opts: { storage: StorageLayer; tokenBudget?: number }) {
    this.storage = opts.storage;
    this.tokenBudget = opts.tokenBudget || 500;
  }

  /**
   * Full two-stage retrieval
   */
  async retrieve(
    queryEmbedding: number[],
    queryText: string,
    llmCall: (prompt: string) => Promise<string>
  ): Promise<RetrievalResult> {
    // Stage I: Theme + Semantic selection
    const { themes, semantics } = await this.stageI(queryEmbedding);

    if (semantics.length === 0) {
      return {
        themes: [],
        semantics: [],
        episodes: [],
        stage2_decision: "NO",
        total_tokens: 0,
      };
    }

    // Stage II: Decide whether to expand
    const { decision, episodes } = await this.stageII(
      queryText,
      semantics,
      llmCall
    );

    // Estimate tokens
    const themeTokens = themes.length * 15;
    const semanticTokens = semantics.reduce(
      (sum, s) => sum + Math.ceil(s.content.length / 4),
      0
    );
    const episodeTokens = episodes.reduce(
      (sum, e) => sum + Math.ceil(e.summary.length / 4),
      0
    );

    return {
      themes,
      semantics,
      episodes,
      stage2_decision: decision,
      total_tokens: themeTokens + semanticTokens + episodeTokens,
    };
  }

  /**
   * Stage I: Greedy submodular selection of themes + semantics
   * Balances coverage and query relevance (xMemory Eq.4)
   */
  private async stageI(
    queryEmbedding: number[]
  ): Promise<{ themes: Theme[]; semantics: Semantic[] }> {
    // Search top themes
    const candidateThemes = await this.storage.searchThemes(queryEmbedding, 5);
    if (candidateThemes.length === 0) {
      return { themes: [], semantics: [] };
    }

    // Greedy selection: pick themes that maximize coverage + relevance
    const alpha = 0.5;
    const selected: Theme[] = [];
    const remaining = [...candidateThemes];
    const covered = new Set<string>();

    while (remaining.length > 0 && selected.length < 3) {
      let bestIdx = 0;
      let bestScore = -Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const theme = remaining[i];
        // Coverage: how many new semantics does this theme bring
        const newSemantics = theme.semantic_ids.filter(
          (id) => !covered.has(id)
        ).length;
        const coverageGain = newSemantics / (theme.semantic_ids.length + 1);

        // Relevance: similarity to query
        const relevance = theme.embedding
          ? cosineSimilarity(queryEmbedding, theme.embedding)
          : 0;

        const score = alpha * coverageGain + (1 - alpha) * relevance;
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }

      const chosen = remaining.splice(bestIdx, 1)[0];
      selected.push(chosen);
      chosen.semantic_ids.forEach((id) => covered.add(id));
    }

    // Expand kNN neighbors for additional coverage
    const neighborIds = new Set<string>();
    for (const theme of selected) {
      for (const nid of theme.knn_neighbors || []) {
        if (!selected.some((t) => t.theme_id === nid)) {
          neighborIds.add(nid);
        }
      }
    }

    // Gather semantics from selected themes
    const allSemantics: Semantic[] = [];
    for (const theme of selected) {
      const themeSems = await this.storage.getSemanticsByTheme(theme.theme_id);
      allSemantics.push(...themeSems);
    }

    // Rank semantics by query relevance, take top 10
    const ranked = allSemantics
      .map((s) => ({
        semantic: s,
        score: s.embedding
          ? cosineSimilarity(queryEmbedding, s.embedding)
          : 0,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((r) => r.semantic);

    return { themes: selected, semantics: ranked };
  }

  /**
   * Stage II: Uncertainty-gated expansion to episodes
   * Uses haiku to judge if semantics are sufficient
   */
  private async stageII(
    queryText: string,
    semantics: Semantic[],
    llmCall: (prompt: string) => Promise<string>
  ): Promise<{ decision: "YES" | "PARTIAL" | "NO"; episodes: Episode[] }> {
    const semanticContext = semantics
      .map((s) => `- ${s.content}`)
      .join("\n");

    const prompt = `Given these facts:\n${semanticContext}\n\nCan they fully answer this question: "${queryText}"?\nReply with exactly one word: YES, PARTIAL, or NO.`;

    const response = await llmCall(prompt);
    const decision = response.trim().toUpperCase() as "YES" | "PARTIAL" | "NO";

    if (decision === "YES") {
      return { decision: "YES", episodes: [] };
    }

    // Expand: get episodes linked to these semantics
    const episodeIds = new Set<string>();
    for (const s of semantics) {
      for (const eid of s.episode_ids || []) {
        episodeIds.add(eid);
      }
    }

    const episodes = await this.storage.getEpisodesByIds([...episodeIds]);

    // Budget control: limit episodes by token budget
    const budgetForEpisodes = this.tokenBudget * 0.4; // 40% of budget
    let tokenCount = 0;
    const kept: Episode[] = [];
    for (const ep of episodes) {
      const epTokens = Math.ceil(ep.summary.length / 4);
      if (tokenCount + epTokens > budgetForEpisodes) break;
      kept.push(ep);
      tokenCount += epTokens;
    }

    return {
      decision: decision === "PARTIAL" ? "PARTIAL" : "NO",
      episodes: kept,
    };
  }

  /**
   * Build retrieval trace for observability
   */
  buildTrace(
    query: string,
    result: RetrievalResult
  ): RetrievalTrace {
    return {
      query,
      timestamp: Date.now(),
      matched_themes: result.themes.map((t) => t.name),
      selected_semantics: result.semantics.map((s) => s.content.slice(0, 50)),
      expanded_episodes: result.episodes.map((e) => e.episode_id),
      stage2_decision: result.stage2_decision,
      total_tokens_injected: result.total_tokens,
    };
  }
}
