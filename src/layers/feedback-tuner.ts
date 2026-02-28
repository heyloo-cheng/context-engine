/**
 * Feedback-driven retrieval weight adjustment (Section 6.2)
 * Adjusts α (coverage vs relevance balance) based on user reactions
 */

import type { ObservabilityTrace } from "../types.js";

export class FeedbackTuner {
  private alpha = 0.5; // coverage vs relevance balance
  private readonly minAlpha = 0.2;
  private readonly maxAlpha = 0.8;
  private readonly learningRate = 0.05;

  getAlpha(): number { return this.alpha; }

  /**
   * Adjust α based on recent traces:
   * - unsatisfied + few semantics → need more coverage → increase α
   * - unsatisfied + many semantics → need more relevance → decrease α
   */
  adjust(traces: ObservabilityTrace[]): void {
    const rated = traces.filter(t => t.user_satisfaction !== "unknown");
    if (rated.length < 3) return;

    const recent = rated.slice(-10);
    let delta = 0;

    for (const t of recent) {
      if (t.user_satisfaction === "unsatisfied") {
        delta += t.selected_semantics.length < 3
          ? this.learningRate   // too few → more coverage
          : -this.learningRate; // enough but irrelevant → more relevance
      }
    }

    this.alpha = Math.max(this.minAlpha, Math.min(this.maxAlpha, this.alpha + delta));
  }
}
