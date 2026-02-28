import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UncertaintyDetector, ActiveRetrieval, MemoryToolkit } from "../src/layers/active-retrieval.ts";

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

describe("MemoryToolkit", () => {
  const toolkit = new MemoryToolkit();

  it("decide: stores novel facts from output", () => {
    const decisions = toolkit.decide(
      "what version is it?",
      "The current version is v2.3.1, released on 2026-02-28.",
      []
    );
    const stores = decisions.filter(d => d.action === "store");
    assert.ok(stores.length >= 1);
    assert.ok(stores[0].importance > 0.5);
  });

  it("decide: skips duplicate facts already in memory", () => {
    const decisions = toolkit.decide(
      "what version?",
      "The current version is v2.3.1 and it was released last week.",
      ["The current version is v2.3.1 and it was released last week."]
    );
    const stores = decisions.filter(d => d.action === "store");
    assert.equal(stores.length, 0);
  });

  it("decide: discards contradicted memory on correction", () => {
    const decisions = toolkit.decide(
      "不对，产品价格应该是100元不是50元",
      "好的，已更正产品价格为100元。",
      ["产品价格是50元每月", "其他完全无关的记忆内容"]
    );
    const discards = decisions.filter(d => d.action === "discard");
    assert.ok(discards.length >= 1);
  });

  it("decide: suggests summarize for large clusters", () => {
    const mems = [
      "context engine version released with basic features and modules",
      "context engine updated with new modules and improvements",
      "context engine adds budget manager and compactor modules",
      "context engine upgraded with temporal memory modules",
      "context engine now has active retrieval feature modules",
      "context engine includes decay manager and modules",
    ];
    const decisions = toolkit.decide("status?", "All good.", mems);
    const summarizes = decisions.filter(d => d.action === "summarize");
    assert.ok(summarizes.length >= 1);
  });

  it("decide: empty output produces no decisions", () => {
    const decisions = toolkit.decide("hi", "Hello!", []);
    assert.equal(decisions.length, 0);
  });

  it("estimateImportance: higher for numeric facts", () => {
    const s1 = toolkit.estimateImportance("The API costs $50/month", "how much?");
    const s2 = toolkit.estimateImportance("It works well", "how is it?");
    assert.ok(s1 > s2);
  });

  it("decayScore: recent memory scores higher", () => {
    const now = Date.now();
    const recent = toolkit.decayScore(now - 86400000, now - 3600000, 5);
    const old = toolkit.decayScore(now - 90 * 86400000, now - 30 * 86400000, 1);
    assert.ok(recent > old);
  });

  it("execute: calls store and forget ops", async () => {
    const stored = [];
    const forgotten = [];
    const decisions = [
      { action: "store", reason: "novel", content: "fact1", importance: 0.8 },
      { action: "discard", reason: "outdated", target: "old memory about X" },
    ];
    const executed = await toolkit.execute(decisions, {
      memoryStore: async (t, c, i) => { stored.push({ t, c, i }); },
      memoryForget: async (q) => { forgotten.push(q); },
    });
    assert.equal(executed, 2);
    assert.equal(stored.length, 1);
    assert.equal(forgotten.length, 1);
  });

  it("execute: handles missing ops gracefully", async () => {
    const decisions = [
      { action: "store", reason: "novel", content: "fact1", importance: 0.8 },
    ];
    const executed = await toolkit.execute(decisions, {});
    assert.equal(executed, 0);
  });
});
