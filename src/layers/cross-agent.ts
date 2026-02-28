/**
 * Cross-Agent Memory Sharing (Section 6.1)
 * Theme layer: globally shared across agents
 * Semantic layer: isolated per agent, with opt-in sharing
 */

import type { Semantic, Theme } from "../types.js";
import type { StorageLayer } from "./storage.js";

// Agent → allowed theme names mapping
const AGENT_THEME_ACCESS: Record<string, string[] | "*"> = {
  main: "*",
  thinker: "*",
  coder: ["coding", "architecture", "deployment"],
  artist: ["design", "ui"],
};

export class CrossAgentSharing {
  /** Filter themes visible to a specific agent */
  filterThemes(themes: Theme[], agentId: string): Theme[] {
    const access = AGENT_THEME_ACCESS[agentId];
    if (!access || access === "*") return themes;
    return themes.filter(t =>
      access.some(a => t.name.toLowerCase().includes(a))
    );
  }

  /** Get semantics to pass when delegating to another agent */
  async getDelegationContext(
    storage: StorageLayer,
    themeIds: string[],
    targetAgent: string
  ): Promise<Semantic[]> {
    const result: Semantic[] = [];
    for (const tid of themeIds) {
      const sems = await storage.getSemanticsByTheme(tid);
      result.push(...sems);
    }
    // Limit to 10 most recent
    return result
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, 10);
  }
}
