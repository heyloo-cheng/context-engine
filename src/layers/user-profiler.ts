/**
 * User Profiler — MemWeaver dual-component memory
 * Behavioral memory: what user did (temporal + semantic edges)
 * Cognitive memory: long-term preferences (phase summaries → global profile)
 */

import type { UserProfile, Episode, Semantic } from "../types.js";
import { embedSingle, generateId } from "../utils/embedding.js";

const BEHAVIORAL_PROMPT = `Summarize what the user did in this period based on these episode summaries. Focus on:
- Actions taken (code written, configs changed, tools used)
- Problems solved
- Projects worked on
Keep it under 100 tokens. Write in the same language as the input.`;

const COGNITIVE_PROMPT = `Based on these behavioral summaries, extract the user's preferences and habits:
- Communication style (language, verbosity)
- Technical preferences (tools, frameworks, patterns)
- Work patterns (time, focus areas)
- Decision-making style
Keep it under 100 tokens. Write in the same language as the input.`;

const GLOBAL_PROMPT = `Merge these phase-level cognitive profiles into one global user profile.
Resolve contradictions by favoring recent phases.
Keep it under 150 tokens. Write in the same language as the input.`;

export class UserProfiler {
  private jinaApiKey: string;

  constructor(opts: { jinaApiKey: string }) {
    this.jinaApiKey = opts.jinaApiKey;
  }

  /**
   * Generate a phase profile from recent episodes and semantics
   */
  async generatePhaseProfile(
    userId: string,
    phase: string,
    episodes: Episode[],
    semantics: Semantic[],
    llmCall: (prompt: string) => Promise<string>
  ): Promise<UserProfile & { embedding: number[] }> {
    // Build behavioral memory from episodes
    const episodeSummaries = episodes
      .map((e) => `- ${e.summary}`)
      .join("\n");

    const behavioral = await llmCall(
      `${BEHAVIORAL_PROMPT}\n\n---\n${episodeSummaries}`
    );

    // Build cognitive memory from behavioral + semantics
    const semanticFacts = semantics
      .map((s) => `- ${s.content}`)
      .join("\n");

    const cognitive = await llmCall(
      `${COGNITIVE_PROMPT}\n\n---\nBehaviors:\n${behavioral}\n\nFacts:\n${semanticFacts}`
    );

    const embedding = await embedSingle(
      `${behavioral} ${cognitive}`,
      this.jinaApiKey
    );

    return {
      profile_id: generateId(),
      user_id: userId,
      phase,
      behavioral,
      cognitive,
      global_profile: cognitive, // Will be merged later
      updated_at: Date.now(),
      embedding,
    };
  }

  /**
   * Merge multiple phase profiles into a global profile
   */
  async mergeGlobalProfile(
    phases: UserProfile[],
    llmCall: (prompt: string) => Promise<string>
  ): Promise<string> {
    if (phases.length === 0) return "";
    if (phases.length === 1) return phases[0].cognitive;

    // Sort by phase (most recent last)
    const sorted = [...phases].sort((a, b) =>
      a.phase.localeCompare(b.phase)
    );

    const phaseTexts = sorted
      .map((p) => `[${p.phase}] ${p.cognitive}`)
      .join("\n\n");

    const global = await llmCall(
      `${GLOBAL_PROMPT}\n\n---\n${phaseTexts}`
    );

    return global;
  }

  /**
   * Get current week phase string
   */
  static getCurrentPhase(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const weekNum = Math.ceil(now.getDate() / 7);
    return `${year}-${month}-W${weekNum}`;
  }
}
