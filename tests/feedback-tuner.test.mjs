import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { FeedbackTuner } = await import("../dist/layers/feedback-tuner.js");

describe("FeedbackTuner", () => {
  it("initial alpha = 0.5", () => {
    const ft = new FeedbackTuner();
    assert.equal(ft.getAlpha(), 0.5);
  });

  it("adjust: unsatisfied + few semantics → increase α", () => {
    const ft = new FeedbackTuner();
    const traces = Array.from({ length: 5 }, () => ({
      query: "q", timestamp: Date.now(), matched_themes: ["t"],
      selected_semantics: ["s"], expanded_episodes: [],
      stage2_decision: "NO", total_tokens_injected: 10,
      user_satisfaction: "unsatisfied", agent_id: undefined,
    }));
    ft.adjust(traces);
    assert.ok(ft.getAlpha() > 0.5);
  });
});
