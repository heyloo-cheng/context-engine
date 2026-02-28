/**
 * Predictive Preloader — Time-pattern based theme preloading (Section 6.3)
 * Analyzes episode timestamps to predict which themes to preload
 */

import type { PreloadRule } from "../types.js";
import type { StorageLayer } from "./storage.js";

export class PredictivePreloader {
  private rules: PreloadRule[] = [];

  getRules(): PreloadRule[] { return this.rules; }

  /** Analyze episodes to build time-pattern rules */
  async buildRules(storage: StorageLayer): Promise<void> {
    const episodes = await storage.searchEpisodes(new Array(1024).fill(0), 200);
    // Group episodes by (dayOfWeek, hourBucket) → theme frequency
    const buckets = new Map<string, Map<string, number>>();

    for (const ep of episodes) {
      const d = new Date(ep.created_at);
      const key = `${d.getDay()}_${Math.floor(d.getHours() / 3)}`; // 3-hour buckets
      if (!buckets.has(key)) buckets.set(key, new Map());
      // We need theme info from semantics — use session_id as proxy
      const themeMap = buckets.get(key)!;
      themeMap.set(ep.session_id, (themeMap.get(ep.session_id) || 0) + 1);
    }

    this.rules = [];
    for (const [key, themeMap] of buckets) {
      const [day, bucket] = key.split("_").map(Number);
      const sorted = [...themeMap.entries()].sort((a, b) => b[1] - a[1]);
      if (sorted.length > 0 && sorted[0][1] >= 3) { // at least 3 occurrences
        this.rules.push({
          dayOfWeek: day,
          hourStart: bucket * 3,
          hourEnd: bucket * 3 + 3,
          themeIds: sorted.slice(0, 2).map(([id]) => id),
        });
      }
    }
  }

  /** Get themes to preload for current time */
  getPreloadThemes(): string[] {
    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();
    const matched = this.rules.filter(
      r => r.dayOfWeek === day && hour >= r.hourStart && hour < r.hourEnd
    );
    return matched.flatMap(r => r.themeIds);
  }
}
