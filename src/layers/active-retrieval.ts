/**
 * U-Mem: Active Memory Retrieval — Uncertainty-driven knowledge acquisition
 * + AgeMem: Autonomous memory management (2601.01885)
 * 
 * When the agent detects uncertainty in its output:
 *   1. Search LanceDB memories (0 cost)
 *   2. Grep workspace files (0 cost)
 *   3. web_search + web_fetch (low cost)
 *   4. deep-search (only for high uncertainty + important questions)
 * 
 * AgeMem additions:
 *   - Memory operations exposed as tool-like actions
 *   - Agent autonomously decides store/retrieve/update/discard
 *   - Decay scoring for automatic memory pruning
 */

// Uncertainty markers
const UNCERTAIN_EN = [
  /\b(i think|i believe|maybe|perhaps|possibly|not sure|might be|could be|probably)\b/i,
  /\b(i('m| am) not (certain|sure|confident))\b/i,
  /\b(as far as i know|to my knowledge|if i recall)\b/i,
];

const UNCERTAIN_ZH = [
  /(可能|大概|也许|或许|不确定|不太清楚|应该是|估计|差不多|好像是)/,
  /(如果我没记错|据我所知|不太确定)/,
];

// Importance markers — questions worth verifying
const IMPORTANT_PATTERNS = [
  /\b(how (much|many)|what (is|are) the (price|cost|version|date))\b/i,
  /\b(is it (true|correct|accurate))\b/i,
  /(多少钱|什么版本|什么时候|是不是真的|准确吗)/,
];

export interface UncertaintySignal {
  level: "none" | "low" | "medium" | "high";
  markers: string[];
  isImportantQuestion: boolean;
}

export interface ActiveRetrievalResult {
  source: "memory" | "workspace" | "web" | "deep-search" | "none";
  findings: string[];
  verified: boolean;
  newFacts: string[]; // facts to store in LanceDB
}

export class UncertaintyDetector {
  /**
   * Analyze output for uncertainty signals
   */
  detect(output: string, query: string): UncertaintySignal {
    const markers: string[] = [];

    // Check English uncertainty
    for (const p of UNCERTAIN_EN) {
      const match = output.match(p);
      if (match) markers.push(match[0]);
    }

    // Check Chinese uncertainty
    for (const p of UNCERTAIN_ZH) {
      const match = output.match(p);
      if (match) markers.push(match[0]);
    }

    // Check if question is important enough to verify
    const isImportantQuestion = IMPORTANT_PATTERNS.some(p => p.test(query));

    // Determine level
    let level: UncertaintySignal["level"];
    if (markers.length === 0) {
      level = "none";
    } else if (markers.length === 1 && !isImportantQuestion) {
      level = "low";
    } else if (markers.length <= 2 || (markers.length === 1 && isImportantQuestion)) {
      level = "medium";
    } else {
      level = "high";
    }

    return { level, markers, isImportantQuestion };
  }

  /**
   * Detect repeated question (user unsatisfied with first answer)
   */
  isRepeatedQuestion(currentQuery: string, recentQueries: string[]): boolean {
    if (recentQueries.length === 0) return false;

    const normalize = (s: string) => s.toLowerCase().replace(/[?？!！。.，,\s]+/g, " ").trim();
    const current = normalize(currentQuery);

    for (const prev of recentQueries.slice(-3)) {
      const prevNorm = normalize(prev);
      // Simple overlap check: >60% word overlap
      const currentWords = new Set(current.split(" "));
      const prevWords = prevNorm.split(" ");
      const overlap = prevWords.filter(w => currentWords.has(w)).length;
      if (overlap / Math.max(currentWords.size, prevWords.length) > 0.6) {
        return true;
      }
    }
    return false;
  }
}

export class ActiveRetrieval {
  private recentQueries: string[] = [];

  /**
   * Execute retrieval chain based on uncertainty level
   */
  async retrieve(
    query: string,
    output: string,
    signal: UncertaintySignal,
    tools: {
      memoryRecall?: (q: string) => Promise<string[]>;
      workspaceGrep?: (q: string) => Promise<string[]>;
      webSearch?: (q: string) => Promise<string[]>;
    }
  ): Promise<ActiveRetrievalResult> {
    // Track queries for repeat detection
    this.recentQueries.push(query);
    if (this.recentQueries.length > 10) this.recentQueries.shift();

    // Level "none" or "low" without importance → skip
    if (signal.level === "none" || (signal.level === "low" && !signal.isImportantQuestion)) {
      return { source: "none", findings: [], verified: false, newFacts: [] };
    }

    const findings: string[] = [];

    // 1. LanceDB memory search (always, 0 cost)
    if (tools.memoryRecall) {
      try {
        const memories = await tools.memoryRecall(query);
        if (memories.length > 0) {
          findings.push(...memories);
          return {
            source: "memory",
            findings,
            verified: true,
            newFacts: [], // already in memory
          };
        }
      } catch { /* continue to next source */ }
    }

    // 2. Workspace grep (0 cost)
    if (tools.workspaceGrep) {
      try {
        const results = await tools.workspaceGrep(query);
        if (results.length > 0) {
          findings.push(...results);
          return {
            source: "workspace",
            findings,
            verified: true,
            newFacts: results.map(r => `Verified from workspace: ${r.slice(0, 200)}`),
          };
        }
      } catch { /* continue */ }
    }

    // 3. Web search (only for medium+ uncertainty)
    if (signal.level !== "low" && tools.webSearch) {
      try {
        const results = await tools.webSearch(query);
        if (results.length > 0) {
          findings.push(...results);

          // Cross-verify: check if web results align with output
          const verified = this.crossVerify(output, results);

          return {
            source: "web",
            findings,
            verified,
            newFacts: verified
              ? results.slice(0, 3).map(r => `Web-verified: ${r.slice(0, 200)}`)
              : [],
          };
        }
      } catch { /* continue */ }
    }

    return { source: "none", findings, verified: false, newFacts: [] };
  }

  /**
   * Simple cross-verification: check if web results support the output
   */
  private crossVerify(output: string, webResults: string[]): boolean {
    // Extract key terms from output (numbers, proper nouns)
    const keyTerms = output.match(/\b[A-Z][a-z]+\b|\b\d+\.?\d*\b/g) || [];
    if (keyTerms.length === 0) return true; // nothing to verify

    // Check if at least 30% of key terms appear in web results
    const combined = webResults.join(" ");
    const matches = keyTerms.filter(t => combined.includes(t));
    return matches.length / keyTerms.length >= 0.3;
  }

  getRecentQueries(): string[] {
    return [...this.recentQueries];
  }
}

// --- AgeMem: Autonomous Memory Management (2601.01885) ---

export type MemoryAction = "store" | "retrieve" | "update" | "discard" | "summarize";

export interface MemoryDecision {
  action: MemoryAction;
  reason: string;
  target?: string;    // memory id for update/discard
  content?: string;   // content for store/update
  importance?: number; // 0-1 for store
}

export interface MemoryToolkitOps {
  memoryRecall?: (q: string) => Promise<string[]>;
  memoryStore?: (text: string, category: string, importance: number) => Promise<void>;
  memoryForget?: (query: string) => Promise<void>;
}

/**
 * AgeMem MemoryToolkit — Agent autonomously decides memory operations
 * 
 * Instead of rule-based store/retrieve, the agent evaluates each turn
 * and decides what memory actions to take based on:
 *   - Information novelty (is this new?)
 *   - Decay score (is existing memory still relevant?)
 *   - Contradiction detection (does new info conflict with stored?)
 *   - Consolidation opportunity (can we merge related memories?)
 */
export class MemoryToolkit {
  private decayHalfLifeMs: number;

  constructor(opts?: { decayHalfLifeDays?: number }) {
    this.decayHalfLifeMs = (opts?.decayHalfLifeDays || 30) * 86400000;
  }

  /**
   * Decide what memory actions to take based on conversation turn.
   * Pure heuristic — no LLM call needed.
   */
  decide(
    userQuery: string,
    assistantOutput: string,
    existingMemories: string[]
  ): MemoryDecision[] {
    const decisions: MemoryDecision[] = [];

    // 1. Store: if output contains novel factual information
    const novelFacts = this.extractNovelFacts(assistantOutput, existingMemories);
    for (const fact of novelFacts.slice(0, 3)) {
      decisions.push({
        action: "store",
        reason: "Novel factual information detected",
        content: fact,
        importance: this.estimateImportance(fact, userQuery),
      });
    }

    // 2. Discard: if user explicitly corrects old info
    if (this.isCorrection(userQuery)) {
      const contradicted = this.findContradicted(userQuery, existingMemories);
      for (const mem of contradicted) {
        decisions.push({
          action: "discard",
          reason: "User correction contradicts stored memory",
          target: mem,
        });
      }
    }

    // 3. Summarize: if too many related memories on same topic
    const clusters = this.detectCluster(existingMemories);
    for (const cluster of clusters) {
      if (cluster.length >= 5) {
        decisions.push({
          action: "summarize",
          reason: `${cluster.length} related memories can be consolidated`,
          content: cluster.join("; "),
        });
      }
    }

    return decisions;
  }

  /**
   * Execute memory decisions
   */
  async execute(decisions: MemoryDecision[], ops: MemoryToolkitOps): Promise<number> {
    let executed = 0;
    for (const d of decisions) {
      try {
        switch (d.action) {
          case "store":
            if (ops.memoryStore && d.content) {
              await ops.memoryStore(d.content, "fact", d.importance || 0.7);
              executed++;
            }
            break;
          case "discard":
            if (ops.memoryForget && d.target) {
              await ops.memoryForget(d.target);
              executed++;
            }
            break;
          case "summarize":
            // Summarize = discard originals + store consolidated
            if (ops.memoryStore && d.content) {
              await ops.memoryStore(`Consolidated: ${d.content.slice(0, 400)}`, "fact", 0.8);
              executed++;
            }
            break;
          // retrieve and update handled by existing U-Mem flow
        }
      } catch { /* skip failed ops */ }
    }
    return executed;
  }

  /**
   * Extract facts from output that don't exist in current memories
   */
  extractNovelFacts(output: string, existingMemories: string[]): string[] {
    // Split into sentences more carefully (avoid splitting on version numbers like v2.3.1)
    const sentences = output
      .replace(/v\d+\.\d+(\.\d+)?/g, (m) => m.replace(/\./g, "·")) // protect version dots
      .split(/(?<=[.!?。！？])\s+/)
      .map(s => s.replace(/·/g, ".")); // restore dots

    // Filter sentences with factual content
    const factPattern = /\b(?:is|are|was|were|costs?|version|released|created|updated)\b|(?:是|为|版本|发布|创建|更新|价格)/i;
    const candidates = sentences
      .filter(s => factPattern.test(s) && s.length > 15 && s.length < 300)
      .slice(0, 10);

    if (existingMemories.length === 0) return candidates;

    // Filter out facts already in memory (>40% word overlap = duplicate)
    const memText = existingMemories.join(" ").toLowerCase();
    return candidates.filter(fact => {
      const words = fact.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      if (words.length === 0) return false;
      const overlap = words.filter(w => memText.includes(w)).length;
      return overlap / words.length < 0.4; // <40% overlap = novel
    });
  }

  /**
   * Estimate importance of a fact (0-1)
   */
  estimateImportance(fact: string, query: string): number {
    let score = 0.5;

    // Boost: contains numbers/versions/dates
    if (/\d/.test(fact)) score += 0.1;
    if (/v?\d+\.\d+/.test(fact)) score += 0.1;

    // Boost: directly answers the query (shared key terms)
    const queryWords = new Set(query.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const factWords = fact.toLowerCase().split(/\s+/);
    const overlap = factWords.filter(w => queryWords.has(w)).length;
    if (overlap >= 2) score += 0.15;

    // Boost: contains proper nouns or technical terms
    if (/[A-Z][a-z]+[A-Z]/.test(fact)) score += 0.05; // CamelCase
    if (/`[^`]+`/.test(fact)) score += 0.05; // inline code

    return Math.min(1.0, Math.round(score * 100) / 100);
  }

  /**
   * Compute decay score for a memory (0-1, lower = more decayed)
   */
  decayScore(createdAt: number, lastAccessedAt: number, accessCount: number): number {
    const age = Date.now() - createdAt;
    const recency = Date.now() - lastAccessedAt;

    // Exponential decay based on age
    const ageFactor = Math.exp(-0.693 * age / this.decayHalfLifeMs); // ln(2) ≈ 0.693

    // Recency boost
    const recencyFactor = Math.exp(-0.693 * recency / (this.decayHalfLifeMs / 2));

    // Access frequency boost (log scale)
    const freqFactor = Math.min(1.0, 0.5 + 0.1 * Math.log2(accessCount + 1));

    return Math.min(1.0, ageFactor * 0.4 + recencyFactor * 0.4 + freqFactor * 0.2);
  }

  private isCorrection(text: string): boolean {
    return /\b(no|wrong|incorrect|actually|not right)\b/i.test(text) ||
      /(不对|错了|不是这样|纠正|应该是|更正)/.test(text);
  }

  private findContradicted(correction: string, memories: string[]): string[] {
    // For Chinese: extract character n-grams; for English: use words
    const corrTokens = this.tokenize(correction);
    const corrSet = new Set(corrTokens);

    return memories.filter(mem => {
      const memTokens = this.tokenize(mem);
      const overlap = memTokens.filter(t => corrSet.has(t)).length;
      return overlap >= 2;
    }).slice(0, 2);
  }

  /**
   * Tokenize text: split English by spaces, Chinese by bigrams
   */
  private tokenize(text: string): string[] {
    const cleaned = text.toLowerCase().replace(/[，。！？,!?.：:；;]/g, " ");
    const tokens: string[] = [];

    // English words
    const enWords = cleaned.match(/[a-z0-9]+/g) || [];
    tokens.push(...enWords.filter(w => w.length > 2));

    // Chinese bigrams (2-char sliding window)
    const cjk = cleaned.replace(/[a-z0-9\s]+/g, "");
    for (let i = 0; i < cjk.length - 1; i++) {
      tokens.push(cjk.slice(i, i + 2));
    }

    return tokens;
  }

  private detectCluster(memories: string[]): string[][] {
    if (memories.length < 5) return [];

    const clusters: string[][] = [];
    const used = new Set<number>();

    for (let i = 0; i < memories.length; i++) {
      if (used.has(i)) continue;
      const cluster = [memories[i]];
      used.add(i);
      const iWords = new Set(memories[i].toLowerCase().split(/\s+/).filter(w => w.length > 2));

      for (let j = i + 1; j < memories.length; j++) {
        if (used.has(j)) continue;
        const jWords = memories[j].toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const overlap = jWords.filter(w => iWords.has(w)).length;
        if (overlap / Math.min(iWords.size, jWords.length) > 0.3) {
          cluster.push(memories[j]);
          used.add(j);
        }
      }

      if (cluster.length >= 5) clusters.push(cluster);
    }

    return clusters;
  }
}
