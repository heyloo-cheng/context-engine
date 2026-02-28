import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Import from dist (compiled)
const { cosineSimilarity, cosineDistance, generateId } = await import("../dist/utils/embedding.js");

describe("embedding utils", () => {
  it("cosineSimilarity: identical vectors = 1", () => {
    const v = [1, 2, 3];
    assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-6);
  });

  it("cosineSimilarity: orthogonal vectors = 0", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    assert.ok(Math.abs(cosineSimilarity(a, b)) < 1e-6);
  });

  it("cosineDistance: identical = 0", () => {
    const v = [1, 2, 3];
    assert.ok(Math.abs(cosineDistance(v, v)) < 1e-6);
  });

  it("generateId: unique", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    assert.equal(ids.size, 100);
  });
});
