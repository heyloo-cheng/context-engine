import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { DecayManager } = await import("../dist/layers/decay-manager.js");

describe("DecayManager", () => {
  it("decayWeight: recent = ~1", () => {
    const dm = new DecayManager();
    const w = dm.decayWeight(Date.now() - 1000, 30);
    assert.ok(w > 0.99);
  });

  it("decayWeight: at half-life = 0.5", () => {
    const dm = new DecayManager();
    const w = dm.decayWeight(Date.now() - 30 * 86400000, 30);
    assert.ok(Math.abs(w - 0.5) < 0.01);
  });

  it("decayWeight: Infinity = always 1", () => {
    const dm = new DecayManager();
    assert.equal(dm.decayWeight(0, Infinity), 1);
  });
});
