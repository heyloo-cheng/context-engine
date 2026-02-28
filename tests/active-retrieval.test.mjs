import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UncertaintyDetector, ActiveRetrieval } from "../src/layers/active-retrieval.ts";

describe("UncertaintyDetector", () => {
  const detector = new UncertaintyDetector();

  it("detect: none for confident output", () => {
    const s = detector.detect("The answer is 42. This is correct.", "what is the answer?");
    assert.equal(s.level, "none");
  });

  it("detect: low for single hedge", () => {
    const s = detector.detect("I think the answer is 42.", "what is it?");
    assert.equal(s.level, "low");
    assert.ok(s.markers.length >= 1);
  });

  it("detect: medium for hedge + important question", () => {
    const s = detector.detect("I think it costs around $50", "how much does it cost?");
    assert.equal(s.level, "medium");
    assert.equal(s.isImportantQuestion, true);
  });

  it("detect: high for multiple hedges", () => {
    const s = detector.detect("Maybe it could be around 50, I'm not sure, possibly more, I think perhaps even higher", "price?");
    assert.ok(s.level === "medium" || s.level === "high");
    assert.ok(s.markers.length >= 2);
  });

  it("detect: Chinese uncertainty markers", () => {
    const s = detector.detect("可能是这样的，不太确定，大概是50", "多少钱？");
    assert.ok(s.level !== "none");
    assert.ok(s.markers.length >= 2);
  });

  it("isRepeatedQuestion: detects similar question", () => {
    const recent = ["what is the price of this product", "tell me about features"];
    assert.equal(detector.isRepeatedQuestion("what is the price of this product?", recent), true);
  });

  it("isRepeatedQuestion: false for different question", () => {
    const recent = ["what is the price", "tell me about features"];
    assert.equal(detector.isRepeatedQuestion("how is the weather today", recent), false);
  });

  it("isRepeatedQuestion: false for empty history", () => {
    assert.equal(detector.isRepeatedQuestion("any question", []), false);
  });
});

describe("ActiveRetrieval", () => {
  it("retrieve: skips for none uncertainty", async () => {
    const ar = new ActiveRetrieval();
    const signal = { level: "none", markers: [], isImportantQuestion: false };
    const result = await ar.retrieve("query", "output", signal, {});
    assert.equal(result.source, "none");
  });

  it("retrieve: searches memory first", async () => {
    const ar = new ActiveRetrieval();
    const signal = { level: "medium", markers: ["maybe"], isImportantQuestion: true };
    const result = await ar.retrieve("query", "output", signal, {
      memoryRecall: async () => ["Found: the price is $50"],
    });
    assert.equal(result.source, "memory");
    assert.equal(result.verified, true);
    assert.ok(result.findings.length > 0);
  });

  it("retrieve: falls back to workspace when memory empty", async () => {
    const ar = new ActiveRetrieval();
    const signal = { level: "medium", markers: ["maybe"], isImportantQuestion: true };
    const result = await ar.retrieve("query", "output", signal, {
      memoryRecall: async () => [],
      workspaceGrep: async () => ["Config: price = 50"],
    });
    assert.equal(result.source, "workspace");
    assert.ok(result.newFacts.length > 0);
  });

  it("retrieve: falls back to web when workspace empty", async () => {
    const ar = new ActiveRetrieval();
    const signal = { level: "medium", markers: ["maybe"], isImportantQuestion: true };
    const result = await ar.retrieve("query", "The price is $50", signal, {
      memoryRecall: async () => [],
      workspaceGrep: async () => [],
      webSearch: async () => ["Official pricing: $50 per month"],
    });
    assert.equal(result.source, "web");
  });

  it("retrieve: handles tool errors gracefully", async () => {
    const ar = new ActiveRetrieval();
    const signal = { level: "high", markers: ["maybe", "not sure", "possibly"], isImportantQuestion: true };
    const result = await ar.retrieve("query", "output", signal, {
      memoryRecall: async () => { throw new Error("DB down"); },
      workspaceGrep: async () => { throw new Error("grep failed"); },
    });
    assert.equal(result.source, "none");
  });

  it("getRecentQueries: tracks queries", async () => {
    const ar = new ActiveRetrieval();
    const signal = { level: "medium", markers: ["maybe"], isImportantQuestion: false };
    await ar.retrieve("query1", "out", signal, {});
    await ar.retrieve("query2", "out", signal, {});
    assert.deepEqual(ar.getRecentQueries(), ["query1", "query2"]);
  });
});
