/**
 * Theme Manager — Organize semantics into themes
 * Implements xMemory's sparsity-semantics guidance for split/merge
 * Maintains kNN graph for cross-theme navigation
 */

import type { Theme, Semantic } from "../types.js";
import { embedSingle, cosineSimilarity, generateId } from "../utils/embedding.js";

const THEME_NAME_PROMPT = `Given these semantic facts, generate a short theme name (2-4 words) that captures their common topic. Output ONLY the name, no explanation. Write in the same language as the facts.`;

const MAX_SEMANTICS_PER_THEME = 12;
const MIN_SEMANTICS_PER_THEME = 3;
const MERGE_SIMILARITY_THRESHOLD = 0.8;
const ASSIGN_DISTANCE_THRESHOLD = 0.3;
const KNN_K = 5;

/**
 * Beta Mixture Model gate for distribution-aware split/merge decisions
 * Based on FluxMem (ICML 2026) — replaces brittle fixed thresholds
 *
 * Models the distribution of theme sizes / similarities as a Beta distribution,
 * and triggers split/merge only when the observation falls in the tail.
 */
export class BetaMixtureGate {
  private observations: number[] = [];
  private maxObs: number;

  constructor(maxObs = 100) {
    this.maxObs = maxObs;
  }

  /**
   * Record an observation (e.g., theme size or similarity score)
   */
  observe(value: number): void {
    this.observations.push(value);
    if (this.observations.length > this.maxObs) this.observations.shift();
  }

  /**
   * Should we trigger? Returns true if value is in the upper tail (> percentile)
   * Falls back to fixed threshold if not enough observations
   */
  shouldTriggerUpper(value: number, fixedThreshold: number, percentile = 0.9): boolean {
    if (this.observations.length < 10) return value > fixedThreshold;
    const sorted = [...this.observations].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * percentile);
    return value > sorted[idx];
  }

  /**
   * Should we trigger? Returns true if value is in the lower tail (< percentile)
   */
  shouldTriggerLower(value: number, fixedThreshold: number, percentile = 0.1): boolean {
    if (this.observations.length < 10) return value < fixedThreshold;
    const sorted = [...this.observations].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * percentile);
    return value < sorted[idx];
  }

  /**
   * Get distribution stats for observability
   */
  getStats(): { mean: number; std: number; count: number } {
    const n = this.observations.length;
    if (n === 0) return { mean: 0, std: 0, count: 0 };
    const mean = this.observations.reduce((s, v) => s + v, 0) / n;
    const variance = this.observations.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    return { mean, std: Math.sqrt(variance), count: n };
  }
}

export class ThemeManager {
  private jinaApiKey: string;
  private splitGate: BetaMixtureGate;
  private mergeGate: BetaMixtureGate;

  constructor(opts: { jinaApiKey: string }) {
    this.jinaApiKey = opts.jinaApiKey;
    this.splitGate = new BetaMixtureGate();
    this.mergeGate = new BetaMixtureGate();
  }

  /**
   * Assign a semantic to the best matching theme, or create a new one
   */
  async assignToTheme(
    semantic: Semantic & { embedding: number[] },
    themes: Theme[],
    llmCall: (prompt: string) => Promise<string>
  ): Promise<{ themeId: string; isNew: boolean; newTheme?: Theme & { embedding: number[] } }> {
    if (themes.length === 0) {
      // No themes exist, create first one
      return this.createNewTheme(semantic, llmCall);
    }

    // Find nearest theme by embedding similarity
    let bestTheme: Theme | null = null;
    let bestSim = -1;

    for (const theme of themes) {
      if (!theme.embedding) continue;
      const sim = cosineSimilarity(semantic.embedding, theme.embedding);
      if (sim > bestSim) {
        bestSim = sim;
        bestTheme = theme;
      }
    }

    // If best similarity is below threshold, create new theme
    if (!bestTheme || bestSim < (1 - ASSIGN_DISTANCE_THRESHOLD)) {
      return this.createNewTheme(semantic, llmCall);
    }

    // Assign to existing theme
    return { themeId: bestTheme.theme_id, isNew: false };
  }

  private async createNewTheme(
    semantic: Semantic & { embedding: number[] },
    llmCall: (prompt: string) => Promise<string>
  ): Promise<{ themeId: string; isNew: boolean; newTheme: Theme & { embedding: number[] } }> {
    const name = await llmCall(
      `${THEME_NAME_PROMPT}\n\nFacts:\n- ${semantic.content}`
    );

    const theme: Theme & { embedding: number[] } = {
      theme_id: generateId(),
      name: name.trim().slice(0, 50),
      summary: semantic.content,
      semantic_ids: [semantic.semantic_id],
      message_count: 1,
      last_active: Date.now(),
      embedding: semantic.embedding, // Use semantic's embedding as initial
      knn_neighbors: [],
    };

    return { themeId: theme.theme_id, isNew: true, newTheme: theme };
  }

  /**
   * Check if a theme needs splitting
   * v1.3: Beta Mixture gate — adapts to actual distribution of theme sizes
   * Falls back to fixed threshold (MAX_SEMANTICS_PER_THEME) with <10 observations
   */
  shouldSplit(theme: Theme): boolean {
    const size = theme.semantic_ids.length;
    this.splitGate.observe(size);
    return this.splitGate.shouldTriggerUpper(size, MAX_SEMANTICS_PER_THEME, 0.9);
  }

  /**
   * Split an overcrowded theme into two using k-means on semantic embeddings
   */
  async splitTheme(
    theme: Theme,
    semantics: (Semantic & { embedding: number[] })[],
    llmCall: (prompt: string) => Promise<string>
  ): Promise<{ theme1: Theme & { embedding: number[] }; theme2: Theme & { embedding: number[] } }> {
    // Simple 2-means clustering
    const n = semantics.length;
    const mid = Math.floor(n / 2);

    // Initialize centroids with first and last semantic
    let c1 = semantics[0].embedding;
    let c2 = semantics[n - 1].embedding;

    // 3 iterations of k-means
    let group1: typeof semantics = [];
    let group2: typeof semantics = [];

    for (let iter = 0; iter < 3; iter++) {
      group1 = [];
      group2 = [];
      for (const s of semantics) {
        const sim1 = cosineSimilarity(s.embedding, c1);
        const sim2 = cosineSimilarity(s.embedding, c2);
        if (sim1 >= sim2) group1.push(s);
        else group2.push(s);
      }
      // Update centroids
      if (group1.length > 0) c1 = this.centroid(group1.map(s => s.embedding));
      if (group2.length > 0) c2 = this.centroid(group2.map(s => s.embedding));
    }

    // Ensure both groups have items
    if (group1.length === 0) { group1.push(group2.pop()!); }
    if (group2.length === 0) { group2.push(group1.pop()!); }

    // Generate names for new themes
    const facts1 = group1.map(s => s.content).join("\n- ");
    const facts2 = group2.map(s => s.content).join("\n- ");
    const [name1, name2] = await Promise.all([
      llmCall(`${THEME_NAME_PROMPT}\n\nFacts:\n- ${facts1}`),
      llmCall(`${THEME_NAME_PROMPT}\n\nFacts:\n- ${facts2}`),
    ]);

    const theme1: Theme & { embedding: number[] } = {
      theme_id: generateId(),
      name: name1.trim().slice(0, 50),
      summary: group1.map(s => s.content).slice(0, 3).join("; "),
      semantic_ids: group1.map(s => s.semantic_id),
      message_count: Math.floor(theme.message_count / 2),
      last_active: Date.now(),
      embedding: c1,
      knn_neighbors: [],
    };

    const theme2: Theme & { embedding: number[] } = {
      theme_id: generateId(),
      name: name2.trim().slice(0, 50),
      summary: group2.map(s => s.content).slice(0, 3).join("; "),
      semantic_ids: group2.map(s => s.semantic_id),
      message_count: theme.message_count - theme1.message_count,
      last_active: Date.now(),
      embedding: c2,
      knn_neighbors: [],
    };

    return { theme1, theme2 };
  }

  /**
   * Check if two themes should merge
   * v1.3: Beta Mixture gate — adapts to actual distribution of inter-theme similarities
   * Merges when both are small AND similarity is in the upper tail
   */
  shouldMerge(theme1: Theme, theme2: Theme): boolean {
    if (theme1.semantic_ids.length >= MIN_SEMANTICS_PER_THEME &&
        theme2.semantic_ids.length >= MIN_SEMANTICS_PER_THEME) {
      return false;
    }
    if (!theme1.embedding || !theme2.embedding) return false;
    const sim = cosineSimilarity(theme1.embedding, theme2.embedding);
    this.mergeGate.observe(sim);
    return this.mergeGate.shouldTriggerUpper(sim, MERGE_SIMILARITY_THRESHOLD, 0.9);
  }

  /**
   * Merge two themes into one
   */
  mergeThemes(theme1: Theme, theme2: Theme): Theme {
    return {
      theme_id: theme1.theme_id, // Keep first theme's ID
      name: theme1.name, // Keep first theme's name
      summary: `${theme1.summary}; ${theme2.summary}`.slice(0, 200),
      semantic_ids: [...theme1.semantic_ids, ...theme2.semantic_ids],
      message_count: theme1.message_count + theme2.message_count,
      last_active: Math.max(theme1.last_active, theme2.last_active),
      embedding: theme1.embedding, // Will be recomputed
      knn_neighbors: [],
    };
  }

  /**
   * Update kNN graph for themes
   */
  updateKNN(themes: Theme[]): void {
    for (const theme of themes) {
      if (!theme.embedding) continue;
      const neighbors: { id: string; sim: number }[] = [];
      for (const other of themes) {
        if (other.theme_id === theme.theme_id || !other.embedding) continue;
        neighbors.push({
          id: other.theme_id,
          sim: cosineSimilarity(theme.embedding, other.embedding),
        });
      }
      neighbors.sort((a, b) => b.sim - a.sim);
      theme.knn_neighbors = neighbors.slice(0, KNN_K).map(n => n.id);
    }
  }

  /**
   * Compute sparsity-semantics score (xMemory Eq.1)
   */
  guidanceScore(themes: Theme[]): number {
    const K = themes.length;
    if (K === 0) return 0;
    const N = themes.reduce((sum, t) => sum + t.semantic_ids.length, 0);
    if (N === 0) return 0;

    // Sparsity score: N^2 / (K * sum(n_k^2))
    const sumSq = themes.reduce((sum, t) => sum + t.semantic_ids.length ** 2, 0);
    const sparsity = (N * N) / (K * sumSq + 1e-10);

    return sparsity;
  }

  /**
   * Get gate distribution stats for observability
   */
  getGateStats(): { split: ReturnType<BetaMixtureGate["getStats"]>; merge: ReturnType<BetaMixtureGate["getStats"]> } {
    return { split: this.splitGate.getStats(), merge: this.mergeGate.getStats() };
  }

  private centroid(vectors: number[][]): number[] {
    const dim = vectors[0].length;
    const result = new Array(dim).fill(0);
    for (const v of vectors) {
      for (let i = 0; i < dim; i++) result[i] += v[i];
    }
    for (let i = 0; i < dim; i++) result[i] /= vectors.length;
    return result;
  }
}
