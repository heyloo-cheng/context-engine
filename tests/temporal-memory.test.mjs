import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TemporalIntentParser,
  SemanticTimeExtractor,
  DurativeMemoryBuilder,
  TemporalRetriever,
} from "../src/layers/temporal-memory.ts";

const DAY = 86400000;
const WEEK = 7 * DAY;
const NOW = new Date("2026-02-28T12:00:00Z").getTime();

describe("TemporalIntentParser", () => {
  const parser = new TemporalIntentParser();

  it("parse: yesterday (EN)", () => {
    const q = parser.parse("what did we discuss yesterday", NOW);
    assert.equal(q.is_temporal, true);
    assert.ok(q.intent_start >= NOW - DAY - 1000);
  });

  it("parse: last week (EN)", () => {
    const q = parser.parse("show me last week's decisions", NOW);
    assert.equal(q.is_temporal, true);
    assert.ok(q.intent_start >= NOW - WEEK - 1000);
  });

  it("parse: 3 days ago (EN)", () => {
    const q = parser.parse("what happened 3 days ago", NOW);
    assert.equal(q.is_temporal, true);
    assert.ok(Math.abs(q.intent_start - (NOW - 3 * DAY)) < 1000);
  });

  it("parse: 昨天 (ZH)", () => {
    const q = parser.parse("昨天讨论了什么", NOW);
    assert.equal(q.is_temporal, true);
  });

  it("parse: 上周 (ZH)", () => {
    const q = parser.parse("上周的决定", NOW);
    assert.equal(q.is_temporal, true);
    assert.ok(q.intent_start >= NOW - WEEK - 1000);
  });

  it("parse: 最近 (ZH)", () => {
    const q = parser.parse("最近有什么进展", NOW);
    assert.equal(q.is_temporal, true);
    assert.ok(q.intent_start >= NOW - 3 * DAY - 1000);
  });

  it("parse: no temporal intent", () => {
    const q = parser.parse("how does context engine work", NOW);
    assert.equal(q.is_temporal, false);
    assert.equal(q.intent_start, null);
  });
});

describe("SemanticTimeExtractor", () => {
  const extractor = new SemanticTimeExtractor();

  it("extractHeuristic: ISO date in summary", () => {
    const r = extractor.extractHeuristic("Deployed v1.2 on 2026-02-25", NOW);
    assert.equal(new Date(r.semantic_time).toISOString().split("T")[0], "2026-02-25");
    assert.equal(r.duration_ms, 0);
  });

  it("extractHeuristic: Chinese date", () => {
    const r = extractor.extractHeuristic("2026年2月20日发布了新版本", NOW);
    assert.equal(new Date(r.semantic_time).toISOString().split("T")[0], "2026-02-20");
  });

  it("extractHeuristic: yesterday in summary", () => {
    const r = extractor.extractHeuristic("Fixed the bug from yesterday", NOW);
    assert.ok(Math.abs(r.semantic_time - (NOW - DAY)) < 1000);
  });

  it("extractHeuristic: last week = durative", () => {
    const r = extractor.extractHeuristic("Worked on this last week", NOW);
    assert.equal(r.duration_ms, WEEK);
  });

  it("extractHeuristic: no date → fallback to dialogueTime", () => {
    const r = extractor.extractHeuristic("General discussion about architecture", NOW);
    assert.equal(r.semantic_time, NOW);
  });
});

describe("DurativeMemoryBuilder", () => {
  const builder = new DurativeMemoryBuilder({ similarityThreshold: 0.5, maxGapDays: 2 });
  const emb = new Array(1024).fill(0.1);

  it("consolidate: merges temporally close + similar events", () => {
    const events = [
      { event_id: "e1", content: "Started project X", semantic_time: NOW - 3 * DAY, dialogue_time: NOW, duration_ms: 0, source_episode_id: "ep1", embedding: emb },
      { event_id: "e2", content: "Continued project X", semantic_time: NOW - 2 * DAY, dialogue_time: NOW, duration_ms: 0, source_episode_id: "ep2", embedding: emb },
      { event_id: "e3", content: "Finished project X", semantic_time: NOW - 1 * DAY, dialogue_time: NOW, duration_ms: 0, source_episode_id: "ep3", embedding: emb },
    ];
    const duratives = builder.consolidate(events);
    assert.equal(duratives.length, 1);
    assert.equal(duratives[0].event_ids.length, 3);
    assert.ok(duratives[0].start_time <= duratives[0].end_time);
  });

  it("consolidate: keeps separate groups for distant events", () => {
    const events = [
      { event_id: "e1", content: "Event A", semantic_time: NOW - 10 * DAY, dialogue_time: NOW, duration_ms: 0, source_episode_id: "ep1", embedding: emb },
      { event_id: "e2", content: "Event B", semantic_time: NOW - 1 * DAY, dialogue_time: NOW, duration_ms: 0, source_episode_id: "ep2", embedding: emb },
    ];
    const duratives = builder.consolidate(events);
    // Both are single events without duration, so no durative created
    assert.equal(duratives.length, 0);
  });

  it("consolidate: single durative event creates durative memory", () => {
    const events = [
      { event_id: "e1", content: "Week-long sprint", semantic_time: NOW - WEEK, dialogue_time: NOW, duration_ms: WEEK, source_episode_id: "ep1", embedding: emb },
    ];
    const duratives = builder.consolidate(events);
    assert.equal(duratives.length, 1);
    assert.equal(duratives[0].event_ids.length, 1);
  });

  it("consolidate: empty input", () => {
    assert.deepEqual(builder.consolidate([]), []);
  });
});

describe("TemporalRetriever", () => {
  const retriever = new TemporalRetriever();

  it("filterByTemporalIntent: filters episodes by time range", () => {
    const episodes = [
      { episode_id: "ep1", summary: "Old stuff", turn_start: 0, turn_end: 5, message_count: 5, session_id: "s", created_at: NOW - 10 * DAY, raw_messages: "[]" },
      { episode_id: "ep2", summary: "Recent stuff", turn_start: 6, turn_end: 10, message_count: 5, session_id: "s", created_at: NOW - 1 * DAY, raw_messages: "[]" },
    ];
    const filtered = retriever.filterByTemporalIntent("what happened yesterday", episodes, undefined, NOW);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].episode_id, "ep2");
  });

  it("filterByTemporalIntent: returns all for non-temporal query", () => {
    const episodes = [
      { episode_id: "ep1", summary: "A", turn_start: 0, turn_end: 5, message_count: 5, session_id: "s", created_at: NOW - 10 * DAY, raw_messages: "[]" },
      { episode_id: "ep2", summary: "B", turn_start: 6, turn_end: 10, message_count: 5, session_id: "s", created_at: NOW - 1 * DAY, raw_messages: "[]" },
    ];
    const filtered = retriever.filterByTemporalIntent("how does X work", episodes, undefined, NOW);
    assert.equal(filtered.length, 2);
  });

  it("filterByTemporalIntent: uses semantic_time from temporal events", () => {
    const episodes = [
      { episode_id: "ep1", summary: "Discussed old event", turn_start: 0, turn_end: 5, message_count: 5, session_id: "s", created_at: NOW, raw_messages: "[]" },
    ];
    const tEvents = [
      { event_id: "ep1", content: "Old event", semantic_time: NOW - 2 * DAY, dialogue_time: NOW, duration_ms: 0, source_episode_id: "ep1" },
    ];
    const filtered = retriever.filterByTemporalIntent("what happened 2 days ago", episodes, tEvents, NOW);
    assert.ok(filtered.length >= 1);
  });

  it("parseQuery: exposes parser", () => {
    const q = retriever.parseQuery("上周做了什么");
    assert.equal(q.is_temporal, true);
  });
});
