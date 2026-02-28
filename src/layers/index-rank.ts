/**
 * Index-Rank-Compact: Workspace File Relevance Ranking
 * 
 * Ranks workspace files by relevance to current query,
 * injects only Top-K files, rest become 1-line summaries.
 */

// Topic categories from context-engine v0.1
const TOPIC_KEYWORDS: Record<string, string[]> = {
  coding: ["code", "bug", "fix", "implement", "function", "class", "error", "compile", "test", "debug", "refactor", "PR", "commit", "git", "代码", "修复", "实现", "编译"],
  config: ["config", "setting", "openclaw.json", "plugin", "install", "setup", "配置", "设置", "安装"],
  memory: ["memory", "remember", "forget", "recall", "MEMORY.md", "LanceDB", "记忆", "记住", "忘记"],
  skill: ["skill", "SKILL.md", "trigger", "recipe", "workflow", "技能", "工作流"],
  agent: ["agent", "delegate", "coder", "thinker", "writer", "session", "委派", "代理"],
  security: ["security", "SecureClaw", "audit", "permission", "安全", "审计", "权限"],
  search: ["search", "web", "fetch", "Exa", "Tavily", "Firecrawl", "搜索", "深搜"],
  planning: ["plan", "roadmap", "phase", "priority", "P0", "P1", "计划", "路线图"],
  chat: ["hello", "hi", "hey", "thanks", "你好", "谢谢", "闲聊"],
};

// File-topic affinity: which files are relevant to which topics
const FILE_TOPIC_AFFINITY: Record<string, string[]> = {
  "AGENTS.md": ["agent", "config", "planning", "skill"],
  "SOUL.md": ["chat", "config"],
  "USER.md": ["chat"],
  "IDENTITY.md": ["chat"],
  "MEMORY.md": ["memory"],
  "HEARTBEAT.md": ["config", "planning"],
  "TOOLS.md": ["config", "search", "skill"],
  "BOOTSTRAP.md": ["config"],
};

export interface RankedFile {
  name: string;
  content: string;
  score: number;
  summary: string; // 1-line summary for non-injected files
}

export class IndexRank {
  private topK: number;
  private recentFiles: Map<string, number> = new Map(); // file → last access timestamp

  constructor(topK = 4) {
    this.topK = topK;
  }

  /**
   * Classify query into topic(s)
   */
  classifyTopic(query: string): string[] {
    const lower = query.toLowerCase();
    const scores: [string, number][] = [];

    for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
      let score = 0;
      for (const kw of keywords) {
        if (lower.includes(kw.toLowerCase())) score++;
      }
      if (score > 0) scores.push([topic, score]);
    }

    scores.sort((a, b) => b[1] - a[1]);
    return scores.length > 0 ? scores.slice(0, 3).map(s => s[0]) : ["chat"];
  }

  /**
   * Score a file's relevance to the current query
   */
  scoreFile(fileName: string, topics: string[], query: string): number {
    let score = 0;

    // 1. Topic affinity (0-3 points)
    const affinities = FILE_TOPIC_AFFINITY[fileName] || [];
    for (const topic of topics) {
      if (affinities.includes(topic)) score += 1.5;
    }

    // 2. Direct mention in query (3 points)
    if (query.toLowerCase().includes(fileName.toLowerCase().replace(".md", ""))) {
      score += 3;
    }

    // 3. Recency bonus (0-1 point, decays over 1 hour)
    const lastAccess = this.recentFiles.get(fileName);
    if (lastAccess) {
      const ageMs = Date.now() - lastAccess;
      const hourMs = 60 * 60 * 1000;
      if (ageMs < hourMs) {
        score += 1 - (ageMs / hourMs);
      }
    }

    // 4. Base importance (some files are always somewhat relevant)
    if (fileName === "AGENTS.md") score += 0.5; // delegation rules
    if (fileName === "MEMORY.md") score += 0.3; // long-term context

    return score;
  }

  /**
   * Rank files and return Top-K with full content + rest as summaries
   */
  rank(
    files: { name: string; content: string }[],
    query: string
  ): { injected: RankedFile[]; summaries: string } {
    const topics = this.classifyTopic(query);

    // Score all files
    const ranked: RankedFile[] = files.map(f => ({
      name: f.name,
      content: f.content,
      score: this.scoreFile(f.name, topics, query),
      summary: this.generateSummary(f.name, f.content),
    }));

    // Sort by score descending
    ranked.sort((a, b) => b.score - a.score);

    // Top-K get full injection
    const injected = ranked.slice(0, this.topK);

    // Rest become 1-line summaries
    const rest = ranked.slice(this.topK);
    const summaryLines = rest
      .filter(f => f.score > 0) // skip completely irrelevant
      .map(f => `- ${f.name}: ${f.summary}`);

    const summaries = summaryLines.length > 0
      ? `## Other workspace files\n${summaryLines.join("\n")}`
      : "";

    // Update recency
    for (const f of injected) {
      this.recentFiles.set(f.name, Date.now());
    }

    return { injected, summaries };
  }

  /**
   * Generate 1-line summary for a file (static, no LLM needed)
   */
  private generateSummary(name: string, content: string): string {
    const summaries: Record<string, string> = {
      "AGENTS.md": "Multi-agent delegation rules, search rules, heartbeat config",
      "SOUL.md": "Agent personality and communication style",
      "USER.md": "User profile and preferences",
      "IDENTITY.md": "Agent identity (name, creature, vibe, emoji)",
      "MEMORY.md": "Long-term memory index and rules",
      "HEARTBEAT.md": "Proactive check schedule and skill recommendations",
      "TOOLS.md": "Local tool notes, API keys, device names",
      "BOOTSTRAP.md": "First-run onboarding script",
    };

    if (summaries[name]) return summaries[name];

    // Fallback: first non-empty, non-header line
    const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("#"));
    return lines[0]?.slice(0, 80) || name;
  }

  setTopK(k: number) {
    this.topK = Math.max(1, Math.min(k, 10));
  }
}
