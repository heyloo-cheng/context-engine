import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IndexRank } from "../src/layers/index-rank.ts";

describe("IndexRank", () => {
  const ir = new IndexRank(2); // Top-2 for testing

  const files = [
    { name: "AGENTS.md", content: "# Agent delegation rules..." },
    { name: "SOUL.md", content: "# Personality..." },
    { name: "MEMORY.md", content: "# Long-term memory..." },
    { name: "TOOLS.md", content: "# API keys and tools..." },
  ];

  it("classifyTopic: coding query", () => {
    const topics = ir.classifyTopic("fix the bug in my code");
    assert.ok(topics.includes("coding"));
  });

  it("classifyTopic: memory query", () => {
    const topics = ir.classifyTopic("do you remember what I said about LanceDB?");
    assert.ok(topics.includes("memory"));
  });

  it("classifyTopic: fallback to chat", () => {
    const topics = ir.classifyTopic("hello there");
    assert.ok(topics.includes("chat"));
  });

  it("rank: returns Top-K injected + summaries", () => {
    const result = ir.rank(files, "delegate this task to the coder agent");
    assert.equal(result.injected.length, 2);
    assert.ok(result.injected[0].score >= result.injected[1].score);
    // AGENTS.md should rank highest for agent-related query
    assert.equal(result.injected[0].name, "AGENTS.md");
  });

  it("rank: summaries contain non-injected files", () => {
    const result = ir.rank(files, "delegate this task to the coder agent");
    // At least some files should appear in summaries
    assert.ok(result.summaries.length > 0 || result.injected.length === files.length);
  });

  it("scoreFile: direct mention boosts score", () => {
    const topics = ir.classifyTopic("update MEMORY.md with new rules");
    const score = ir.scoreFile("MEMORY.md", topics, "update MEMORY.md with new rules");
    assert.ok(score >= 3); // direct mention = +3
  });
});
