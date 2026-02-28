/**
 * Decay Manager — Layered forgetting strategy (Section 6.4)
 * Theme: never forget | Semantic: 180d | Episode: 30d | Message: 7d
 */

import type { DecayConfig } from "../types.js";
import { DEFAULT_DECAY } from "../types.js";
import type { StorageLayer } from "./storage.js";

export class DecayManager {
  private config: DecayConfig;

  constructor(config?: Partial<DecayConfig>) {
    this.config = { ...DEFAULT_DECAY, ...config };
  }

  /** Run decay sweep — call from cron_weekly */
  async sweep(storage: StorageLayer, logger: { info: (m: string) => void }): Promise<void> {
    const now = Date.now();

    // 1. Episodes: delete old ones past half-life * 3 (effectively gone)
    const episodeCutoff = now - this.config.episodeHalfLifeDays * 3 * 86400000;
    const episodes = await storage.searchEpisodes(new Array(1024).fill(0), 500);
    for (const ep of episodes) {
      if (ep.created_at < episodeCutoff) {
        await storage.deleteEpisode(ep.episode_id);
        logger.info(`[decay] Deleted episode ${ep.episode_id}`);
      } else if (ep.created_at < now - this.config.messageRetainDays * 86400000) {
        // Strip raw messages but keep summary
        if (ep.raw_messages && ep.raw_messages !== "[]") {
          await storage.updateEpisode(ep.episode_id, { raw_messages: "[]" });
          logger.info(`[decay] Stripped messages from episode ${ep.episode_id}`);
        }
      }
    }

    // 2. Semantics: delete very old ones
    if (this.config.semanticHalfLifeDays !== Infinity) {
      const semCutoff = now - this.config.semanticHalfLifeDays * 3 * 86400000;
      const sems = await storage.searchSemantics(new Array(1024).fill(0), 500);
      for (const s of sems) {
        if (s.created_at < semCutoff) {
          await storage.deleteSemantic(s.semantic_id);
          logger.info(`[decay] Deleted semantic ${s.semantic_id}`);
        }
      }
    }
    // Themes: never deleted (themeHalfLifeDays = Infinity)
  }

  /** Compute decay weight for retrieval scoring (0-1) */
  decayWeight(createdAt: number, halfLifeDays: number): number {
    if (halfLifeDays === Infinity) return 1;
    const ageDays = (Date.now() - createdAt) / 86400000;
    return Math.pow(0.5, ageDays / halfLifeDays);
  }
}
