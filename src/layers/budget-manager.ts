/**
 * Budget Manager — Token budget allocation across context sources
 * 
 * Priority tiers:
 *   P0 (identity): SOUL.md, IDENTITY.md — always injected
 *   P1 (context): Top-K workspace files from IndexRank
 *   P2 (memory): context-engine retrieval (themes, semantics, episodes)
 *   P3 (tools): compacted tool outputs
 *   P4 (extras): file summaries, heartbeat state
 * 
 * Over budget → trim from P4 upward
 */

export interface BudgetAllocation {
  tier: string;
  label: string;
  tokens: number;
  maxTokens: number;
  content: string;
  trimmed: boolean;
}

export interface BudgetReport {
  totalBudget: number;
  totalUsed: number;
  savings: number;       // tokens saved vs no-budget injection
  allocations: BudgetAllocation[];
}

export class BudgetManager {
  private totalBudget: number;

  // Default tier budgets (% of total)
  private tierRatios: Record<string, number> = {
    identity: 0.10,   // P0: ~400 tokens
    workspace: 0.35,  // P1: ~1400 tokens
    memory: 0.30,     // P2: ~1200 tokens
    tools: 0.15,      // P3: ~600 tokens
    extras: 0.10,     // P4: ~400 tokens
  };

  constructor(totalBudget = 4000) {
    this.totalBudget = totalBudget;
  }

  /**
   * Allocate budget across tiers
   */
  allocate(items: {
    tier: string;
    label: string;
    content: string;
  }[]): BudgetReport {
    const tierBudgets: Record<string, number> = {};
    for (const [tier, ratio] of Object.entries(this.tierRatios)) {
      tierBudgets[tier] = Math.floor(this.totalBudget * ratio);
    }

    // Group items by tier
    const grouped: Record<string, typeof items> = {};
    for (const item of items) {
      if (!grouped[item.tier]) grouped[item.tier] = [];
      grouped[item.tier].push(item);
    }

    const allocations: BudgetAllocation[] = [];
    let totalUsed = 0;
    let originalTotal = 0;

    // Process tiers in priority order
    const tierOrder = ["identity", "workspace", "memory", "tools", "extras"];

    for (const tier of tierOrder) {
      const tierItems = grouped[tier] || [];
      const maxForTier = tierBudgets[tier] || 0;
      let tierUsed = 0;

      for (const item of tierItems) {
        const tokens = this.estimateTokens(item.content);
        originalTotal += tokens;

        if (tierUsed + tokens <= maxForTier) {
          // Fits within tier budget
          allocations.push({
            tier,
            label: item.label,
            tokens,
            maxTokens: maxForTier,
            content: item.content,
            trimmed: false,
          });
          tierUsed += tokens;
        } else {
          // Trim to fit remaining budget
          const remaining = maxForTier - tierUsed;
          if (remaining > 50) {
            const trimmed = this.trimToTokens(item.content, remaining);
            const trimmedTokens = this.estimateTokens(trimmed);
            allocations.push({
              tier,
              label: item.label,
              tokens: trimmedTokens,
              maxTokens: maxForTier,
              content: trimmed,
              trimmed: true,
            });
            tierUsed += trimmedTokens;
          }
          // else: skip entirely (too little budget left)
        }
      }

      totalUsed += tierUsed;
    }

    // If still over total budget, trim from P4 upward
    if (totalUsed > this.totalBudget) {
      const excess = totalUsed - this.totalBudget;
      let trimmed = 0;

      // Trim from lowest priority first
      for (let i = allocations.length - 1; i >= 0 && trimmed < excess; i--) {
        const alloc = allocations[i];
        if (alloc.tier === "identity") continue; // never trim identity

        const canTrim = Math.min(alloc.tokens, excess - trimmed);
        if (canTrim >= alloc.tokens) {
          // Remove entirely
          trimmed += alloc.tokens;
          totalUsed -= alloc.tokens;
          alloc.content = "";
          alloc.tokens = 0;
          alloc.trimmed = true;
        } else {
          // Partial trim
          alloc.content = this.trimToTokens(alloc.content, alloc.tokens - canTrim);
          const newTokens = this.estimateTokens(alloc.content);
          trimmed += alloc.tokens - newTokens;
          totalUsed -= alloc.tokens - newTokens;
          alloc.tokens = newTokens;
          alloc.trimmed = true;
        }
      }
    }

    return {
      totalBudget: this.totalBudget,
      totalUsed,
      savings: originalTotal - totalUsed,
      allocations: allocations.filter(a => a.tokens > 0),
    };
  }

  /**
   * Trim content to approximately N tokens
   */
  private trimToTokens(content: string, maxTokens: number): string {
    const lines = content.split("\n");
    const result: string[] = [];
    let tokens = 0;

    for (const line of lines) {
      const lt = this.estimateTokens(line);
      if (tokens + lt > maxTokens) break;
      result.push(line);
      tokens += lt;
    }

    return result.join("\n");
  }

  private estimateTokens(text: string): number {
    const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
    const nonCjk = text.length - cjk;
    return Math.ceil(nonCjk / 4 + cjk / 2);
  }

  setBudget(budget: number) {
    this.totalBudget = Math.max(1000, budget);
  }

  setTierRatio(tier: string, ratio: number) {
    if (this.tierRatios[tier] !== undefined) {
      this.tierRatios[tier] = Math.max(0, Math.min(1, ratio));
    }
  }
}
