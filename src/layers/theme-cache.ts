/**
 * Theme-level Semantic Cache (Section 6.5)
 * Cache key = theme_id + query_embedding → 2-3x hit rate vs flat cache
 */

import { cosineSimilarity } from "../utils/embedding.js";

interface CacheEntry {
  themeId: string;
  queryEmbedding: number[];
  response: string;
  createdAt: number;
}

export class ThemeCache {
  private entries: CacheEntry[] = [];
  private maxEntries = 200;
  private threshold = 0.85; // similarity threshold for cache hit

  lookup(themeId: string, queryEmbedding: number[]): string | null {
    for (const e of this.entries) {
      if (e.themeId !== themeId) continue;
      if (cosineSimilarity(e.queryEmbedding, queryEmbedding) >= this.threshold) {
        return e.response;
      }
    }
    return null;
  }

  store(themeId: string, queryEmbedding: number[], response: string): void {
    this.entries.push({ themeId, queryEmbedding, response, createdAt: Date.now() });
    if (this.entries.length > this.maxEntries) this.entries.shift();
  }

  invalidateTheme(themeId: string): void {
    this.entries = this.entries.filter(e => e.themeId !== themeId);
  }

  stats(): { size: number; themes: number } {
    const themes = new Set(this.entries.map(e => e.themeId));
    return { size: this.entries.length, themes: themes.size };
  }
}
