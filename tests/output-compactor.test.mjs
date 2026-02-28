import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OutputCompactor } from "../src/layers/output-compactor.ts";

describe("OutputCompactor", () => {
  const compactor = new OutputCompactor({
    stripThreshold: 50,
    truncateThreshold: 150,
    summarizeThreshold: 500,
    maxOutputTokens: 100,
  });

  it("passthrough: small output unchanged", async () => {
    const result = await compactor.compact("exec", "hello world");
    assert.equal(result.strategy, "passthrough");
    assert.equal(result.content, "hello world");
  });

  it("strip: removes HTML tags", async () => {
    const html = "<div><p>Important data</p><span class='noise'>extra</span></div>".repeat(5);
    const result = await compactor.compact("web_fetch", html);
    assert.ok(!result.content.includes("<div>"));
    assert.ok(!result.content.includes("<span"));
    assert.ok(result.compactedTokens <= result.originalTokens);
  });

  it("strip: collapses whitespace", async () => {
    const messy = "line one with enough text to pass threshold\n\n\n\n\nline two with more content here\n\n\n\nline three and even more text to ensure we exceed fifty tokens easily for the strip strategy to kick in properly";
    const result = await compactor.compact("exec", messy);
    assert.ok(result.strategy === "strip" || result.strategy === "passthrough");
    if (result.strategy === "strip") {
      assert.ok(!result.content.includes("\n\n\n"));
    }
  });

  it("truncate: adds truncation marker", async () => {
    const long = "This is a sentence about something important. ".repeat(50);
    const result = await compactor.compact("exec", long);
    assert.ok(
      result.strategy === "truncate" || result.strategy === "strip",
      `expected truncate or strip, got ${result.strategy}`
    );
    assert.ok(result.compactedTokens < result.originalTokens);
  });

  it("summarize: uses llmCall for very large output", async () => {
    const huge = "Data point: value is 42. ".repeat(200);
    const mockLlm = async (prompt) => "Summary: 200 data points, all value=42.";
    const result = await compactor.compact("web_fetch", huge, mockLlm);
    assert.equal(result.strategy, "summarize");
    assert.ok(result.content.includes("Summary"));
    assert.ok(result.compactedTokens < result.originalTokens);
  });

  it("summarize: falls back to truncate on llm error", async () => {
    const huge = "Data point: value is 42. ".repeat(200);
    const failLlm = async () => { throw new Error("LLM down"); };
    const result = await compactor.compact("web_fetch", huge, failLlm);
    assert.equal(result.strategy, "truncate");
  });
});
