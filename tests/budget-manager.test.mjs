import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BudgetManager } from "../src/layers/budget-manager.ts";

describe("BudgetManager", () => {
  it("allocate: respects total budget", () => {
    const bm = new BudgetManager(1000);
    const items = [
      { tier: "identity", label: "soul", content: "I am an AI assistant. ".repeat(10) },
      { tier: "workspace", label: "agents", content: "Delegation rules. ".repeat(30) },
      { tier: "memory", label: "themes", content: "Active topics: coding, search. ".repeat(20) },
      { tier: "tools", label: "exec-output", content: "Command output here. ".repeat(15) },
      { tier: "extras", label: "summaries", content: "Other files summary. ".repeat(10) },
    ];
    const report = bm.allocate(items);
    assert.ok(report.totalUsed <= report.totalBudget);
  });

  it("allocate: identity tier never trimmed", () => {
    const bm = new BudgetManager(500); // very tight budget
    const items = [
      { tier: "identity", label: "soul", content: "Core identity text." },
      { tier: "workspace", label: "agents", content: "Long content. ".repeat(100) },
      { tier: "memory", label: "themes", content: "More content. ".repeat(100) },
    ];
    const report = bm.allocate(items);
    const identity = report.allocations.find(a => a.tier === "identity");
    assert.ok(identity, "identity allocation should exist");
    assert.equal(identity.trimmed, false);
  });

  it("allocate: reports savings", () => {
    const bm = new BudgetManager(500);
    const items = [
      { tier: "workspace", label: "big-file", content: "x".repeat(5000) },
    ];
    const report = bm.allocate(items);
    assert.ok(report.savings > 0);
  });

  it("allocate: empty items → zero usage", () => {
    const bm = new BudgetManager(4000);
    const report = bm.allocate([]);
    assert.equal(report.totalUsed, 0);
    assert.equal(report.allocations.length, 0);
  });

  it("setBudget: enforces minimum 1000", () => {
    const bm = new BudgetManager(4000);
    bm.setBudget(100);
    const items = [
      { tier: "identity", label: "soul", content: "Test content for budget." },
    ];
    const report = bm.allocate(items);
    assert.equal(report.totalBudget, 1000);
  });

  it("allocate: multiple items in same tier share budget", () => {
    const bm = new BudgetManager(2000);
    const items = [
      { tier: "memory", label: "themes", content: "Topic A. ".repeat(20) },
      { tier: "memory", label: "semantics", content: "Fact B. ".repeat(20) },
      { tier: "memory", label: "episodes", content: "Detail C. ".repeat(20) },
    ];
    const report = bm.allocate(items);
    const memoryItems = report.allocations.filter(a => a.tier === "memory");
    const memoryTotal = memoryItems.reduce((s, a) => s + a.tokens, 0);
    // Memory tier = 30% of 2000 = 600
    assert.ok(memoryTotal <= 600);
  });
});
