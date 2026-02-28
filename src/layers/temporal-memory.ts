/**
 * Temporal Semantic Memory (TSM) — Based on TSM paper (2601.07468) + Memory-T1 (ICLR 2026)
 *
 * Key ideas:
 * 1. Semantic timeline: events indexed by when they *happened*, not when they were *discussed*
 * 2. Durative memory: merge temporally continuous + semantically related info into persistent states
 * 3. Temporal intent parsing: "last week" / "上周" → map to semantic timeline range
 */

import type { Episode } from "../types.js";

// Inline cosine similarity to avoid embedding.js dependency in tests
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// --- Types ---

export interface TemporalEvent {
  event_id: string;
  content: string;
  semantic_time: number;      // when the event actually happened (ms)
  dialogue_time: number;      // when it was discussed (ms)
  duration_ms: number;        // 0 = point event, >0 = durative
  source_episode_id: string;
  embedding?: number[];
}

export interface DurativeMemory {
  durative_id: string;
  summary: string;
  start_time: number;         // semantic start
  end_time: number;           // semantic end
  event_ids: string[];
  theme: string;              // e.g. "project-X development"
  embedding?: number[];
  last_updated: number;
}

export interface TemporalQuery {
  original: string;
  intent_start: number | null;  // null = no temporal constraint
  intent_end: number | null;
  is_temporal: boolean;
}

// --- Temporal Intent Parser ---

export class TemporalIntentParser {
  private patterns: { regex: RegExp; resolver: (now: number, match: RegExpMatchArray) => [number, number] }[];

  constructor() {
    const DAY = 86400000;
    const WEEK = 7 * DAY;
    const MONTH = 30 * DAY;

    this.patterns = [
      // English
      { regex: /yesterday/i, resolver: (now) => [now - DAY, now] },
      { regex: /last\s+week/i, resolver: (now) => [now - WEEK, now] },
      { regex: /last\s+month/i, resolver: (now) => [now - MONTH, now] },
      { regex: /today/i, resolver: (now) => [now - DAY, now] },
      { regex: /(\d+)\s+days?\s+ago/i, resolver: (now, m) => [now - parseInt(m[1]) * DAY, now] },
      { regex: /(\d+)\s+weeks?\s+ago/i, resolver: (now, m) => [now - parseInt(m[1]) * WEEK, now] },
      { regex: /this\s+week/i, resolver: (now) => [now - (new Date(now).getDay()) * DAY, now] },
      { regex: /this\s+month/i, resolver: (now) => {
        const d = new Date(now); d.setDate(1); d.setHours(0,0,0,0);
        return [d.getTime(), now];
      }},
      // Chinese
      { regex: /昨天/, resolver: (now) => [now - DAY, now] },
      { regex: /上周|上个星期/, resolver: (now) => [now - WEEK, now] },
      { regex: /上个月/, resolver: (now) => [now - MONTH, now] },
      { regex: /今天/, resolver: (now) => [now - DAY, now] },
      { regex: /(\d+)\s*天前/, resolver: (now, m) => [now - parseInt(m[1]) * DAY, now] },
      { regex: /(\d+)\s*周前/, resolver: (now, m) => [now - parseInt(m[1]) * WEEK, now] },
      { regex: /这周|本周/, resolver: (now) => [now - (new Date(now).getDay()) * DAY, now] },
      { regex: /这个月|本月/, resolver: (now) => {
        const d = new Date(now); d.setDate(1); d.setHours(0,0,0,0);
        return [d.getTime(), now];
      }},
      { regex: /最近/, resolver: (now) => [now - 3 * DAY, now] },
      { regex: /recently/i, resolver: (now) => [now - 3 * DAY, now] },
    ];
  }

  parse(query: string, now?: number): TemporalQuery {
    const ts = now || Date.now();
    for (const { regex, resolver } of this.patterns) {
      const match = query.match(regex);
      if (match) {
        const [start, end] = resolver(ts, match);
        return { original: query, intent_start: start, intent_end: end, is_temporal: true };
      }
    }
    return { original: query, intent_start: null, intent_end: null, is_temporal: false };
  }
}

// --- Semantic Time Extractor ---

export class SemanticTimeExtractor {
  /**
   * Extract semantic time from episode summary using LLM.
   * Falls back to dialogue_time if extraction fails.
   */
  async extractSemanticTime(
    summary: string,
    dialogueTime: number,
    llmCall: (prompt: string) => Promise<string>
  ): Promise<{ semantic_time: number; duration_ms: number }> {
    const dateStr = new Date(dialogueTime).toISOString().split("T")[0];
    const prompt = `Given this conversation summary discussed on ${dateStr}:
"${summary.slice(0, 300)}"

When did the described event(s) actually happen? Reply in JSON:
{"date":"YYYY-MM-DD","duration_days":0}
- date: the actual event date (use ${dateStr} if same as discussion)
- duration_days: 0 for point events, >0 for ongoing states
Reply ONLY the JSON.`;

    try {
      const resp = await llmCall(prompt);
      const json = JSON.parse(resp.replace(/```json?\n?/g, "").replace(/```/g, "").trim());
      const semantic_time = new Date(json.date).getTime();
      const duration_ms = (json.duration_days || 0) * 86400000;
      if (isNaN(semantic_time)) return { semantic_time: dialogueTime, duration_ms: 0 };
      return { semantic_time, duration_ms };
    } catch {
      return { semantic_time: dialogueTime, duration_ms: 0 };
    }
  }

  /**
   * Cheap heuristic extraction without LLM — regex date patterns
   */
  extractHeuristic(summary: string, dialogueTime: number): { semantic_time: number; duration_ms: number } {
    // Try ISO date
    const isoMatch = summary.match(/(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) {
      const t = new Date(isoMatch[1]).getTime();
      if (!isNaN(t)) return { semantic_time: t, duration_ms: 0 };
    }
    // Try Chinese date
    const cnMatch = summary.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (cnMatch) {
      const t = new Date(`${cnMatch[1]}-${cnMatch[2].padStart(2,"0")}-${cnMatch[3].padStart(2,"0")}`).getTime();
      if (!isNaN(t)) return { semantic_time: t, duration_ms: 0 };
    }
    // Relative: "yesterday" / "昨天" in summary
    const DAY = 86400000;
    if (/yesterday|昨天/.test(summary)) return { semantic_time: dialogueTime - DAY, duration_ms: 0 };
    if (/last week|上周/.test(summary)) return { semantic_time: dialogueTime - 7 * DAY, duration_ms: 7 * DAY };

    return { semantic_time: dialogueTime, duration_ms: 0 };
  }
}

// --- Durative Memory Builder ---

export class DurativeMemoryBuilder {
  private similarityThreshold: number;
  private maxGapMs: number;

  constructor(opts?: { similarityThreshold?: number; maxGapDays?: number }) {
    this.similarityThreshold = opts?.similarityThreshold || 0.6;
    this.maxGapMs = (opts?.maxGapDays || 3) * 86400000;
  }

  /**
   * Consolidate temporal events into durative memories.
   * Merges events that are temporally continuous + semantically related.
   */
  consolidate(events: TemporalEvent[]): DurativeMemory[] {
    if (events.length === 0) return [];

    // Sort by semantic_time
    const sorted = [...events].sort((a, b) => a.semantic_time - b.semantic_time);
    const duratives: DurativeMemory[] = [];
    const used = new Set<string>();

    for (const event of sorted) {
      if (used.has(event.event_id)) continue;

      // Start a new durative group
      const group: TemporalEvent[] = [event];
      used.add(event.event_id);

      // Find temporally close + semantically similar events
      for (const candidate of sorted) {
        if (used.has(candidate.event_id)) continue;
        const lastInGroup = group[group.length - 1];

        // Temporal proximity check
        const gap = candidate.semantic_time - (lastInGroup.semantic_time + lastInGroup.duration_ms);
        if (gap > this.maxGapMs) continue;

        // Semantic similarity check
        if (event.embedding && candidate.embedding) {
          const sim = cosineSimilarity(event.embedding, candidate.embedding);
          if (sim < this.similarityThreshold) continue;
        }

        group.push(candidate);
        used.add(candidate.event_id);
      }

      // Only create durative memory if group has >1 event or event itself is durative
      if (group.length > 1 || event.duration_ms > 0) {
        const startTime = group[0].semantic_time;
        const lastEvt = group[group.length - 1];
        const endTime = lastEvt.semantic_time + lastEvt.duration_ms;

        duratives.push({
          durative_id: `dur_${event.event_id.slice(0, 8)}`,
          summary: group.map(e => e.content).join("; "),
          start_time: startTime,
          end_time: endTime || startTime,
          event_ids: group.map(e => e.event_id),
          theme: "",  // filled by caller
          embedding: event.embedding,
          last_updated: Date.now(),
        });
      }
    }

    return duratives;
  }
}

// --- Temporal Retriever (augments TopDownRetriever) ---

export class TemporalRetriever {
  private parser: TemporalIntentParser;

  constructor() {
    this.parser = new TemporalIntentParser();
  }

  /**
   * Filter episodes by temporal intent from query.
   * Returns filtered + reranked episodes with temporal relevance boost.
   */
  filterByTemporalIntent(
    query: string,
    episodes: Episode[],
    temporalEvents?: TemporalEvent[],
    now?: number
  ): Episode[] {
    const tq = this.parser.parse(query, now);
    if (!tq.is_temporal || tq.intent_start === null) return episodes;

    const start = tq.intent_start!;
    const end = tq.intent_end!;

    // If we have temporal events, use semantic_time; otherwise fall back to created_at
    if (temporalEvents && temporalEvents.length > 0) {
      const eventByEpisode = new Map<string, TemporalEvent[]>();
      for (const te of temporalEvents) {
        const arr = eventByEpisode.get(te.source_episode_id) || [];
        arr.push(te);
        eventByEpisode.set(te.source_episode_id, arr);
      }

      return episodes
        .map(ep => {
          const events = eventByEpisode.get(ep.episode_id) || [];
          // Check if any event falls in the temporal range
          const inRange = events.some(e =>
            e.semantic_time >= start && e.semantic_time <= end
          );
          // Temporal proximity score (closer to range center = higher)
          const center = (start + end) / 2;
          const closestEvent = events.length > 0
            ? Math.min(...events.map(e => Math.abs(e.semantic_time - center)))
            : Math.abs(ep.created_at - center);
          const range = end - start || 86400000;
          const proximityScore = inRange ? 1.0 : Math.max(0, 1 - closestEvent / range);

          return { episode: ep, score: proximityScore };
        })
        .filter(r => r.score > 0.1)
        .sort((a, b) => b.score - a.score)
        .map(r => r.episode);
    }

    // Fallback: use created_at (dialogue time)
    return episodes
      .filter(ep => ep.created_at >= start && ep.created_at <= end)
      .sort((a, b) => {
        const center = (start + end) / 2;
        return Math.abs(a.created_at - center) - Math.abs(b.created_at - center);
      });
  }

  parseQuery(query: string): TemporalQuery {
    return this.parser.parse(query);
  }
}
