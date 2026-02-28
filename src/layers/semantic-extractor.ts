/**
 * Semantic Extractor — Extract reusable facts from episodes
 * Uses haiku to distill semantic units from episode summaries
 */

import type { Semantic, Episode } from "../types.js";
import { embedSingle, cosineDistance, generateId } from "../utils/embedding.js";

const EXTRACT_PROMPT = `You are a fact extractor. Given a conversation episode summary, extract 1-3 reusable facts.

Rules:
- Each fact should be a standalone statement (< 20 tokens)
- Facts should be reusable across conversations (not ephemeral)
- Skip greetings, acknowledgments, and process details
- Write in the same language as the input

Output format: one fact per line, no numbering, no bullets.`;

export class SemanticExtractor {
  private jinaApiKey: string;
  private dedupeThreshold: number;

  constructor(opts: { jinaApiKey: string; dedupeThreshold?: number }) {
    this.jinaApiKey = opts.jinaApiKey;
    this.dedupeThreshold = opts.dedupeThreshold || 0.15;
  }

  /**
   * Extract semantic facts from an episode
   */
  async extract(
    episode: Episode,
    existingSemantics: Semantic[],
    llmCall: (prompt: string) => Promise<string>
  ): Promise<(Semantic & { embedding: number[] })[]> {
    // Ask haiku to extract facts
    const response = await llmCall(
      `${EXTRACT_PROMPT}\n\n---\nEpisode: ${episode.summary}`
    );

    // Parse response into individual facts
    const facts = response
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 3 && l.length < 200);

    if (facts.length === 0) return [];

    const results: (Semantic & { embedding: number[] })[] = [];

    for (const fact of facts) {
      // Embed the fact
      const embedding = await embedSingle(fact, this.jinaApiKey);

      // Dedupe: check against existing semantics
      const isDuplicate = existingSemantics.some((s) => {
        if (!s.embedding) return false;
        return cosineDistance(embedding, s.embedding) < this.dedupeThreshold;
      });

      if (isDuplicate) continue;

      results.push({
        semantic_id: generateId(),
        theme_id: "", // Will be assigned by ThemeManager
        content: fact,
        episode_ids: [episode.episode_id],
        created_at: Date.now(),
        updated_at: Date.now(),
        embedding,
        knn_neighbors: [],
      });
    }

    return results;
  }
}
