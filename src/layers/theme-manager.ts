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

export class ThemeManager {
  private jinaApiKey: string;

  constructor(opts: { jinaApiKey: string }) {
    this.jinaApiKey = opts.jinaApiKey;
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
   * Check if a theme needs splitting (too many semantics)
   * Uses xMemory's sparsity-semantics guidance (Eq.1)
   */
  shouldSplit(theme: Theme): boolean {
    return theme.semantic_ids.length > MAX_SEMANTICS_PER_THEME;
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
   * Check if two themes should merge (both small and similar)
   */
  shouldMerge(theme1: Theme, theme2: Theme): boolean {
    if (theme1.semantic_ids.length >= MIN_SEMANTICS_PER_THEME &&
        theme2.semantic_ids.length >= MIN_SEMANTICS_PER_THEME) {
      return false;
    }
    if (!theme1.embedding || !theme2.embedding) return false;
    return cosineSimilarity(theme1.embedding, theme2.embedding) > MERGE_SIMILARITY_THRESHOLD;
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
