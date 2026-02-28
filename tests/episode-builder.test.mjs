import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { EpisodeBuilder } = await import("../dist/layers/episode-builder.js");

describe("EpisodeBuilder", () => {
  it("hasPending: false initially", () => {
    const eb = new EpisodeBuilder({ jinaApiKey: "fake" });
    assert.equal(eb.hasPending(), false);
  });

  it("addMessage: returns true when batch full", () => {
    const eb = new EpisodeBuilder({ jinaApiKey: "fake", batchSize: 3 });
    assert.equal(eb.addMessage({ role: "user", content: "a" }), false);
    assert.equal(eb.addMessage({ role: "assistant", content: "b" }), false);
    assert.equal(eb.addMessage({ role: "user", content: "c" }), true);
    assert.equal(eb.hasPending(), true);
  });

  it("detectTopicSwitch: detects markers", () => {
    const eb = new EpisodeBuilder({ jinaApiKey: "fake" });
    const prev = { role: "user", content: "fix the bug" };
    const curr = { role: "user", content: "换个话题，帮我看看部署" };
    assert.equal(eb.detectTopicSwitch(curr, prev), true);
  });

  it("detectTopicSwitch: no false positive", () => {
    const eb = new EpisodeBuilder({ jinaApiKey: "fake" });
    const prev = { role: "user", content: "fix the bug" };
    const curr = { role: "user", content: "still broken" };
    assert.equal(eb.detectTopicSwitch(curr, prev), false);
  });
});
