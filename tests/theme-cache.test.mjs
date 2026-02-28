import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { ThemeCache } = await import("../dist/layers/theme-cache.js");

describe("ThemeCache", () => {
  it("store + lookup: cache hit on same theme + similar query", () => {
    const tc = new ThemeCache();
    const emb = [1, 0, 0];
    tc.store("t1", emb, "cached response");
    assert.equal(tc.lookup("t1", emb), "cached response");
  });

  it("lookup: miss on different theme", () => {
    const tc = new ThemeCache();
    tc.store("t1", [1, 0, 0], "resp");
    assert.equal(tc.lookup("t2", [1, 0, 0]), null);
  });

  it("invalidateTheme: clears entries", () => {
    const tc = new ThemeCache();
    tc.store("t1", [1, 0, 0], "resp");
    tc.invalidateTheme("t1");
    assert.equal(tc.lookup("t1", [1, 0, 0]), null);
    assert.equal(tc.stats().size, 0);
  });
});
