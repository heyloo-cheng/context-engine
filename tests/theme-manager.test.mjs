import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { ThemeManager } = await import("../dist/layers/theme-manager.js");

const makeTheme = (id, semCount, embedding = [1, 0, 0]) => ({
  theme_id: id,
  name: `theme-${id}`,
  summary: "test",
  semantic_ids: Array.from({ length: semCount }, (_, i) => `s${id}_${i}`),
  message_count: semCount,
  last_active: Date.now(),
  embedding,
  knn_neighbors: [],
});

describe("ThemeManager", () => {
  const tm = new ThemeManager({ jinaApiKey: "fake" });

  it("shouldSplit: true when > 12 semantics", () => {
    assert.equal(tm.shouldSplit(makeTheme("a", 13)), true);
    assert.equal(tm.shouldSplit(makeTheme("b", 12)), false);
  });

  it("shouldMerge: true when small + similar", () => {
    const t1 = makeTheme("a", 2, [1, 0, 0]);
    const t2 = makeTheme("b", 2, [1, 0.01, 0]);
    assert.equal(tm.shouldMerge(t1, t2), true);
  });

  it("shouldMerge: false when both >= 3", () => {
    const t1 = makeTheme("a", 3, [1, 0, 0]);
    const t2 = makeTheme("b", 3, [1, 0.01, 0]);
    assert.equal(tm.shouldMerge(t1, t2), false);
  });

  it("mergeThemes: combines semantic_ids", () => {
    const t1 = makeTheme("a", 2);
    const t2 = makeTheme("b", 3);
    const merged = tm.mergeThemes(t1, t2);
    assert.equal(merged.semantic_ids.length, 5);
    assert.equal(merged.theme_id, "a");
  });

  it("updateKNN: populates knn_neighbors", () => {
    const themes = [
      makeTheme("a", 5, [1, 0, 0]),
      makeTheme("b", 5, [0.9, 0.1, 0]),
      makeTheme("c", 5, [0, 1, 0]),
    ];
    tm.updateKNN(themes);
    assert.ok(themes[0].knn_neighbors.length > 0);
    assert.equal(themes[0].knn_neighbors[0], "b"); // most similar
  });

  it("guidanceScore: balanced themes score higher", () => {
    const balanced = [makeTheme("a", 5), makeTheme("b", 5)];
    const skewed = [makeTheme("a", 9), makeTheme("b", 1)];
    assert.ok(tm.guidanceScore(balanced) > tm.guidanceScore(skewed));
  });
});
