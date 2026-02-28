/**
 * FlowEngine — Zero-cost multi-agent DAG orchestration
 * 
 * Inspired by:
 *   - claude-router (0xrdan): zero-latency rule-based classification + LLM fallback
 *   - MoMA (arxiv 2509.07571): context-aware state machine routing
 *   - M1-Parallel (ICML, arxiv 2507.08944): event-driven async parallel execution
 *   - Flyte 2.0 Planner Agent: dependency-aware "wave" parallel execution
 *   - Cost Control Hierarchy: no-LLM > cache > small model > batch > route > frontier
 *
 * 4 Layers:
 *   L1: Zero-Cost Router (regex + history fingerprint)
 *   L2: Flow Resolver (template pipeline vs single dispatch)
 *   L3: Wave Executor (topological sort → parallel sessions_send)
 *   L4: Learning Loop (record outcomes → promote to rules)
 */

// ============================================================
// Types
// ============================================================

export type AgentId = "thinker" | "coder" | "writer" | "artist" | "news" | "cursor-ops" | string;

export interface RouteRule {
  /** Regex patterns to match against user message */
  patterns: RegExp[];
  /** Target agent */
  agent: AgentId;
  /** Optional prompt template ({{task}} replaced with user message) */
  promptTemplate?: string;
  /** Priority (higher = checked first) */
  priority: number;
}

export interface FlowStep {
  id: string;
  agent: AgentId;
  /** Prompt template — {{task}} = original task, {{stepN}} = output of step N */
  prompt: string;
  /** Step IDs this step depends on */
  dependsOn: string[];
}

export interface FlowTemplate {
  name: string;
  /** Regex patterns that trigger this flow */
  triggers: RegExp[];
  steps: FlowStep[];
}

export interface RouteDecision {
  agent: AgentId;
  prompt: string;
  method: "rule" | "fingerprint" | "fallback";
  confidence: number;
}

export interface FlowPlan {
  template: string;
  waves: FlowStep[][];  // topologically sorted into parallel waves
}

export interface DispatchResult {
  stepId: string;
  agent: AgentId;
  success: boolean;
  output?: string;
  tokenCost?: number;
  durationMs?: number;
}

export interface DelegationRecord {
  fingerprint: string;
  agent: AgentId;
  template?: string;
  successCount: number;
  failCount: number;
  avgTokens: number;
  lastUsed: number;
}

// ============================================================
// L1: Zero-Cost Router
// ============================================================

export class ZeroCostRouter {
  private rules: RouteRule[];
  private history: DelegationRecord[] = [];
  private maxHistory = 200;

  constructor(rules?: RouteRule[]) {
    this.rules = (rules || ZeroCostRouter.defaultRules())
      .sort((a, b) => b.priority - a.priority);
  }

  static defaultRules(): RouteRule[] {
    return [
      {
        patterns: [
          /\.(swift|ts|tsx|js|jsx|py|rs|go|java|kt|cpp|c|h|css|html|vue|svelte)\b/i,
          /\b(bug|fix|refactor|implement|build|compile|test|lint|debug|PR|pull request|merge|commit)\b/i,
          /(代码|修复|重构|实现|编译|测试|调试|提交|代码审查)/,
          /\b(review|code review)\b/i,
        ],
        agent: "coder",
        priority: 10,
      },
      {
        patterns: [
          /(写一篇|翻译|文档|文章|摘要|总结)/,
          /\b(translate|document|README|changelog|blog|write|draft|compose|edit|proofread|copywrite)\b/i,
        ],
        agent: "writer",
        priority: 10,
      },
      {
        patterns: [
          /(设计|海报|图片|UI设计|画)/,
          /\b(poster|logo|image|illustration|banner|icon|design|visual|graphic)\b/i,
          /\b(generate.*image)\b/i,
        ],
        agent: "artist",
        priority: 10,
      },
      {
        patterns: [
          /(分析|调研|深度|思考|方案|评估|对比|权衡)/,
          /\b(analyze|research|think|plan|architect|compare|pros.*cons|trade.?off)\b/i,
        ],
        agent: "thinker",
        priority: 8,
      },
      {
        patterns: [
          /\b(cursor|Cursor)\b/,
        ],
        agent: "cursor-ops",
        priority: 12,
      },
      {
        patterns: [
          /(新闻|早报|晚报)/,
          /\b(news|headlines|briefing)\b/i,
        ],
        agent: "news",
        priority: 10,
      },
    ];
  }

  /**
   * Route by regex rules — O(patterns), zero LLM cost
   */
  routeByRules(message: string): RouteDecision | null {
    for (const rule of this.rules) {
      for (const pattern of rule.patterns) {
        if (pattern.test(message)) {
          return {
            agent: rule.agent,
            prompt: rule.promptTemplate
              ? rule.promptTemplate.replace("{{task}}", message)
              : message,
            method: "rule",
            confidence: 0.9,
          };
        }
      }
    }
    return null;
  }

  /**
   * Route by historical fingerprint — word overlap matching, zero LLM cost
   */
  routeByFingerprint(message: string): RouteDecision | null {
    if (this.history.length === 0) return null;

    const msgWords = new Set(this.tokenize(message));
    let bestMatch: DelegationRecord | null = null;
    let bestScore = 0;

    for (const record of this.history) {
      if (record.successCount < 2) continue; // need at least 2 successes
      const fpWords = this.tokenize(record.fingerprint);
      const overlap = fpWords.filter(w => msgWords.has(w)).length;
      const score = overlap / Math.max(fpWords.length, 1);
      if (score > bestScore && score > 0.5) {
        bestScore = score;
        bestMatch = record;
      }
    }

    if (!bestMatch) return null;
    return {
      agent: bestMatch.agent,
      prompt: message,
      method: "fingerprint",
      confidence: Math.min(bestScore, 0.85),
    };
  }

  /**
   * Full routing: rules → fingerprint → null (caller does haiku fallback)
   */
  route(message: string): RouteDecision | null {
    return this.routeByRules(message) || this.routeByFingerprint(message);
  }

  /** Record a delegation outcome for learning */
  recordDelegation(message: string, agent: AgentId, success: boolean, tokens?: number): void {
    const fp = this.fingerprint(message);
    const existing = this.history.find(r => r.fingerprint === fp && r.agent === agent);

    if (existing) {
      if (success) existing.successCount++;
      else existing.failCount++;
      if (tokens) {
        existing.avgTokens = Math.round(
          (existing.avgTokens * (existing.successCount + existing.failCount - 1) + tokens) /
          (existing.successCount + existing.failCount)
        );
      }
      existing.lastUsed = Date.now();
    } else {
      this.history.push({
        fingerprint: fp,
        agent,
        successCount: success ? 1 : 0,
        failCount: success ? 0 : 1,
        avgTokens: tokens || 0,
        lastUsed: Date.now(),
      });
      // Prune old entries
      if (this.history.length > this.maxHistory) {
        this.history.sort((a, b) => b.lastUsed - a.lastUsed);
        this.history = this.history.slice(0, this.maxHistory);
      }
    }
  }

  /** Promote high-confidence fingerprints to rules */
  promoteToRules(): number {
    let promoted = 0;
    for (const record of this.history) {
      if (record.successCount >= 3 && record.failCount === 0) {
        // Check if a rule already covers this
        const alreadyCovered = this.routeByRules(record.fingerprint);
        if (alreadyCovered && alreadyCovered.agent === record.agent) continue;

        // Create a new rule from fingerprint keywords
        const words = this.tokenize(record.fingerprint);
        if (words.length < 2) continue;
        const pattern = new RegExp(words.slice(0, 3).join(".*"), "i");
        this.rules.push({
          patterns: [pattern],
          agent: record.agent,
          priority: 6, // lower than defaults
        });
        promoted++;
      }
    }
    if (promoted > 0) {
      this.rules.sort((a, b) => b.priority - a.priority);
    }
    return promoted;
  }

  getHistory(): DelegationRecord[] { return [...this.history]; }
  getRules(): RouteRule[] { return [...this.rules]; }

  private fingerprint(text: string): string {
    return this.tokenize(text).sort().join(" ");
  }

  private tokenize(text: string): string[] {
    const tokens: string[] = [];
    // English words
    const en = text.toLowerCase().match(/[a-z][a-z0-9_.-]{2,}/g) || [];
    tokens.push(...en);
    // Chinese: extract 2-char bigrams
    const cjk = text.replace(/[a-zA-Z0-9\s.,!?;:'"()\[\]{}/<>@#$%^&*+=~`|\\-]/g, "");
    for (let i = 0; i < cjk.length - 1; i++) {
      tokens.push(cjk.slice(i, i + 2));
    }
    return [...new Set(tokens)];
  }
}

// ============================================================
// L2: Flow Resolver — match templates or fall back to single dispatch
// ============================================================

export class FlowResolver {
  private templates: FlowTemplate[];

  constructor(templates?: FlowTemplate[]) {
    this.templates = templates || FlowResolver.defaultTemplates();
  }

  static defaultTemplates(): FlowTemplate[] {
    return [
      {
        name: "feature-dev",
        triggers: [
          /(新功能|开发.*功能)/,
          /\b(new feature|implement.*feature)\b/i,
          /(build|创建|搭建).*(app|应用|模块|module|组件|component)/i,
        ],
        steps: [
          { id: "analyze", agent: "thinker", prompt: "分析需求并输出技术方案:\n{{task}}", dependsOn: [] },
          { id: "implement", agent: "coder", prompt: "按方案实现:\n{{analyze}}", dependsOn: ["analyze"] },
          { id: "document", agent: "writer", prompt: "为以下实现写文档:\n{{analyze}}\n\n实现结果:\n{{implement}}", dependsOn: ["analyze"] },
          { id: "review", agent: "coder", prompt: "Review代码质量:\n{{implement}}", dependsOn: ["implement"] },
        ],
      },
      {
        name: "code-review",
        triggers: [
          /(review|审查|检查).*(code|代码|PR|pull request|MR)/i,
          /(代码|code).*(review|审查|检查)/i,
        ],
        steps: [
          { id: "analyze", agent: "thinker", prompt: "分析代码变更的影响范围和风险:\n{{task}}", dependsOn: [] },
          { id: "review", agent: "coder", prompt: "详细代码审查，基于分析:\n{{analyze}}\n\n原始请求:\n{{task}}", dependsOn: ["analyze"] },
        ],
      },
      {
        name: "research-write",
        triggers: [
          /(调研|research|研究).*(写|write|文章|article|报告|report)/i,
          /(写|write).*(调研|research|分析|analysis)/i,
        ],
        steps: [
          { id: "research", agent: "thinker", prompt: "深度调研:\n{{task}}", dependsOn: [] },
          { id: "write", agent: "writer", prompt: "基于调研结果撰写:\n{{research}}\n\n原始需求:\n{{task}}", dependsOn: ["research"] },
        ],
      },
    ];
  }

  /**
   * Match a flow template by triggers — zero LLM cost
   */
  resolve(message: string): FlowPlan | null {
    for (const tpl of this.templates) {
      for (const trigger of tpl.triggers) {
        if (trigger.test(message)) {
          return {
            template: tpl.name,
            waves: this.topoSort(tpl.steps),
          };
        }
      }
    }
    return null;
  }

  /**
   * Topological sort into parallel waves (Flyte-style)
   * Steps with no unresolved dependencies go in the same wave
   */
  topoSort(steps: FlowStep[]): FlowStep[][] {
    const waves: FlowStep[][] = [];
    const completed = new Set<string>();
    const remaining = [...steps];

    let safety = 0;
    while (remaining.length > 0 && safety++ < 20) {
      const wave: FlowStep[] = [];
      const nextRemaining: FlowStep[] = [];

      for (const step of remaining) {
        const depsResolved = step.dependsOn.every(d => completed.has(d));
        if (depsResolved) {
          wave.push(step);
        } else {
          nextRemaining.push(step);
        }
      }

      if (wave.length === 0) {
        // Circular dependency — force remaining into last wave
        waves.push(nextRemaining);
        break;
      }

      waves.push(wave);
      for (const s of wave) completed.add(s.id);
      remaining.length = 0;
      remaining.push(...nextRemaining);
    }

    return waves;
  }

  getTemplates(): FlowTemplate[] { return [...this.templates]; }

  addTemplate(template: FlowTemplate): void {
    this.templates.push(template);
  }
}

// ============================================================
// L3: Wave Executor — parallel dispatch + context passing
// ============================================================

export interface ExecutorOps {
  /** Send task to agent, return output string */
  dispatch: (agent: AgentId, prompt: string) => Promise<string>;
}

export class WaveExecutor {
  private maxRetries: number;

  constructor(maxRetries = 1) {
    this.maxRetries = maxRetries;
  }

  /**
   * Execute a flow plan wave by wave
   * Steps in the same wave run in parallel
   * Step outputs are substituted into downstream prompts via {{stepId}}
   */
  async execute(
    plan: FlowPlan,
    task: string,
    ops: ExecutorOps,
  ): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];
    const outputs: Record<string, string> = { task };

    for (const wave of plan.waves) {
      const wavePromises = wave.map(async (step): Promise<DispatchResult> => {
        // Substitute variables in prompt
        let prompt = step.prompt;
        prompt = prompt.replace(/\{\{task\}\}/g, task);
        for (const [key, val] of Object.entries(outputs)) {
          prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), val);
        }

        const start = Date.now();
        let output = "";
        let success = false;

        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
          try {
            output = await ops.dispatch(step.agent, prompt);
            success = true;
            break;
          } catch {
            if (attempt === this.maxRetries) {
              output = `[ERROR] Step ${step.id} failed after ${this.maxRetries + 1} attempts`;
            }
          }
        }

        return {
          stepId: step.id,
          agent: step.agent,
          success,
          output,
          durationMs: Date.now() - start,
        };
      });

      const waveResults = await Promise.all(wavePromises);

      for (const r of waveResults) {
        results.push(r);
        if (r.success && r.output) {
          outputs[r.stepId] = r.output;
        }
      }

      // If any step in wave failed, stop execution
      if (waveResults.some(r => !r.success)) break;
    }

    return results;
  }
}

// ============================================================
// L4: Learning Loop — record + promote
// ============================================================

export class LearningLoop {
  private router: ZeroCostRouter;
  private promotionInterval: number;
  private delegationCount = 0;

  constructor(router: ZeroCostRouter, promotionInterval = 20) {
    this.router = router;
    this.promotionInterval = promotionInterval;
  }

  /** Record outcome and periodically promote fingerprints to rules */
  record(message: string, agent: AgentId, success: boolean, tokens?: number): void {
    this.router.recordDelegation(message, agent, success, tokens);
    this.delegationCount++;

    // Auto-promote every N delegations
    if (this.delegationCount % this.promotionInterval === 0) {
      this.router.promoteToRules();
    }
  }

  getStats(): { totalDelegations: number; historySize: number; rulesCount: number } {
    return {
      totalDelegations: this.delegationCount,
      historySize: this.router.getHistory().length,
      rulesCount: this.router.getRules().length,
    };
  }
}

// ============================================================
// FlowEngine — unified facade
// ============================================================

export class FlowEngine {
  readonly router: ZeroCostRouter;
  readonly resolver: FlowResolver;
  readonly executor: WaveExecutor;
  readonly learner: LearningLoop;

  constructor(opts?: {
    rules?: RouteRule[];
    templates?: FlowTemplate[];
    maxRetries?: number;
    promotionInterval?: number;
  }) {
    this.router = new ZeroCostRouter(opts?.rules);
    this.resolver = new FlowResolver(opts?.templates);
    this.executor = new WaveExecutor(opts?.maxRetries);
    this.learner = new LearningLoop(this.router, opts?.promotionInterval);
  }

  /**
   * Main entry: decide how to handle a task
   * Returns either a single RouteDecision or a FlowPlan
   */
  plan(message: string): { type: "single"; route: RouteDecision } | { type: "flow"; plan: FlowPlan } | null {
    // 1. Check flow templates first (multi-step > single-step)
    const flow = this.resolver.resolve(message);
    if (flow) return { type: "flow", plan: flow };

    // 2. Single-agent routing
    const route = this.router.route(message);
    if (route) return { type: "single", route };

    // 3. No match — caller should use haiku fallback or handle directly
    return null;
  }

  /** Estimate if task is worth delegating (> 200 token output expected) */
  shouldDelegate(message: string): boolean {
    // Short messages are likely chat — don't delegate
    if (message.length < 30) return false;
    // Questions about status/config — don't delegate
    if (/^(status|状态|怎么样|how are|what's up)/i.test(message)) return false;
    // Greetings — don't delegate
    if (/^(hi|hello|hey|你好|早|晚安|嗨)/i.test(message)) return false;
    return true;
  }
}
