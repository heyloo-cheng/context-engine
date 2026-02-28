import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { TopDownRetriever } = await import("../dist/layers/retriever.js");

// Mock storage
const mockStorage = {
  searchThemes: async () => [
    { theme_id: "t1", name: "coding", summary: "code stuff", semantic_ids: ["s1", "s2"], message_count: 5, last_active: Date.now(), embedding: [1, 0, 0], knn_neighbors: [] },
  ],
  getSemanticsByTheme: async () => [
    { semantic_id: "s1", theme_id: "t1", content: "Use TypeScript strict mode", episode_ids: ["e1"], created_at: 0, updated_at: 0, embedding: [1, 0, 0], knn_neighbors: [] },
    { semantic_id: "s2", theme_id: "t1", content: "LanceDB for vector storage", episode_ids: ["e1"], created_at: 0, updated_at: 0, embedding: [0.9, 0.1, 0], knn_neighbors: [] },
  ],
  getEpisodesByIds: async () => [
    { episode_id: "e1", summary: "Discussed TypeScript config", turn_start: 0, turn_end: 4, message_count: 5, session_id: "s", created_at: 0, raw_messages: "[]" },
  ],
};

describe("TopDownRetriever", () => {
  it("retrieve: returns themes + semantics for YES decision", async () => {
    const r = new TopDownRetriever({ storage: mockStorage, tokenBudget: 500 });
    const mockLlm = async () => "YES";
    const result = await r.retrieve([1, 0, 0], "how to configure TS?", mockLlm);
    assert.ok(result.themes.length > 0);
    assert.ok(result.semantics.length > 0);
    assert.equal(result.stage2_decision, "YES");
    assert.equal(result.episodes.length, 0); // YES = no expansion
  });

  it("retrieve: expands episodes for PARTIAL", async () => {
    const r = new TopDownRetriever({ storage: mockStorage, tokenBudget: 500 });
    const mockLlm = async () => "PARTIAL";
    const result = await r.retrieve([1, 0, 0], "details about TS setup?", mockLlm);
    assert.equal(result.stage2_decision, "PARTIAL");
    assert.ok(result.episodes.length > 0);
  });

  it("retrieve: empty when no themes match", async () => {
    const emptyStorage = { ...mockStorage, searchThemes: async () => [] };
    const r = new TopDownRetriever({ storage: emptyStorage, tokenBudget: 500 });
    const result = await r.retrieve([1, 0, 0], "test", async () => "NO");
    assert.equal(result.themes.length, 0);
    assert.equal(result.semantics.length, 0);
  });

  it("buildTrace: captures retrieval metadata", () => {
    const r = new TopDownRetriever({ storage: mockStorage, tokenBudget: 500 });
    const trace = r.buildTrace("test query", {
      themes: [{ theme_id: "t1", name: "coding", summary: "", semantic_ids: [], message_count: 0, last_active: 0, knn_neighbors: [] }],
      semantics: [{ semantic_id: "s1", theme_id: "t1", content: "fact one here", episode_ids: [], created_at: 0, updated_at: 0, knn_neighbors: [] }],
      episodes: [],
      stage2_decision: "YES",
      total_tokens: 50,
    });
    assert.equal(trace.query, "test query");
    assert.equal(trace.matched_themes[0], "coding");
    assert.equal(trace.stage2_decision, "YES");
  });
});
