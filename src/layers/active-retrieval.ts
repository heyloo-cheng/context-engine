/**
 * U-Mem: Active Memory Retrieval — Uncertainty-driven knowledge acquisition
 * 
 * When the agent detects uncertainty in its output:
 *   1. Search LanceDB memories (0 cost)
 *   2. Grep workspace files (0 cost)
 *   3. web_search + web_fetch (low cost)
 *   4. deep-search (only for high uncertainty + important questions)
 * 
 * Results are cross-verified and stored as new facts.
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
