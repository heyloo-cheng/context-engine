/**
 * Observability — Retrieval trace persistence + reporting (Section 6.6)
 */

import type { ObservabilityTrace, RetrievalResult } from "../types.js";
import type { StorageLayer } from "./storage.js";

export class ObservabilityManager {
  private traces: ObservabilityTrace[] = [];
  private maxInMemory = 100;

  buildTrace(query: string, result: RetrievalResult, agentId?: string): ObservabilityTrace {
    return {
      query,
      timestamp: Date.now(),
      matched_themes: result.themes.map(t => t.name),
      selected_semantics: result.semantics.map(s => s.content.slice(0, 50)),
      expanded_episodes: result.episodes.map(e => e.episode_id),
      stage2_decision: result.stage2_decision,
      total_tokens_injected: result.total_tokens,
      user_satisfaction: "unknown",
      agent_id: agentId,
    };
  }

  record(trace: ObservabilityTrace): void {
    this.traces.push(trace);
    if (this.traces.length > this.maxInMemory) this.traces.shift();
  }

  /** Mark last trace as satisfied/unsatisfied based on user follow-up */
  markSatisfaction(satisfied: boolean): void {
    const last = this.traces[this.traces.length - 1];
    if (last) last.user_satisfaction = satisfied ? "satisfied" : "unsatisfied";
  }

  /** Generate stats report */
  report(): { total: number; hitRate: number; avgTokens: number; satisfactionRate: number } {
    const total = this.traces.length;
    if (total === 0) return { total: 0, hitRate: 0, avgTokens: 0, satisfactionRate: 0 };

    const hits = this.traces.filter(t => t.matched_themes.length > 0).length;
    const avgTokens = this.traces.reduce((s, t) => s + t.total_tokens_injected, 0) / total;
    const rated = this.traces.filter(t => t.user_satisfaction !== "unknown");
    const satisfactionRate = rated.length > 0
      ? rated.filter(t => t.user_satisfaction === "satisfied").length / rated.length
      : 0;

    return { total, hitRate: hits / total, avgTokens, satisfactionRate };
  }

  getTraces(): ObservabilityTrace[] { return this.traces; }
}
