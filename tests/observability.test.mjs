import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { ObservabilityManager } = await import("../dist/layers/observability.js");

describe("ObservabilityManager", () => {
  it("record + report: tracks traces", () => {
    const om = new ObservabilityManager();
    const trace = om.buildTrace("test", {
      themes: [{ theme_id: "t1", name: "coding", summary: "", semantic_ids: [], message_count: 0, last_active: 0, knn_neighbors: [] }],
      semantics: [], episodes: [], stage2_decision: "YES", total_tokens: 50,
    });
    om.record(trace);
    const r = om.report();
    assert.equal(r.total, 1);
    assert.equal(r.hitRate, 1);
  });

  it("markSatisfaction: updates last trace", () => {
    const om = new ObservabilityManager();
    om.record(om.buildTrace("q", { themes: [], semantics: [], episodes: [], stage2_decision: "NO", total_tokens: 0 }));
    om.markSatisfaction(true);
    assert.equal(om.getTraces()[0].user_satisfaction, "satisfied");
  });
});
