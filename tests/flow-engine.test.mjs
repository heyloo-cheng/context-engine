import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ZeroCostRouter,
  FlowResolver,
  WaveExecutor,
  LearningLoop,
  FlowEngine,
} from "../src/layers/flow-engine.ts";

describe("ZeroCostRouter", () => {
  const router = new ZeroCostRouter();

  it("routes code tasks to coder", () => {
    const r = router.route("fix the bug in main.ts");
    assert.ok(r);
    assert.equal(r.agent, "coder");
    assert.equal(r.method, "rule");
  });

  it("routes Chinese code tasks to coder", () => {
    const r = router.route("帮我重构这段代码");
    assert.ok(r);
    assert.equal(r.agent, "coder");
  });

  it("routes writing tasks to writer", () => {
    const r = router.route("写一篇关于AI的文章");
    assert.ok(r);
    assert.equal(r.agent, "writer");
  });

  it("routes translate to writer", () => {
    const r = router.route("translate this document to Chinese");
    assert.ok(r);
    assert.equal(r.agent, "writer");
  });

  it("routes design tasks to artist", () => {
    const r = router.route("设计一个海报");
    assert.ok(r);
    assert.equal(r.agent, "artist");
  });

  it("routes analysis to thinker", () => {
    const r = router.route("分析一下这个方案的优缺点");
    assert.ok(r);
    assert.equal(r.agent, "thinker");
  });

  it("routes cursor tasks to cursor-ops", () => {
    const r = router.route("用Cursor打开项目");
    assert.ok(r);
    assert.equal(r.agent, "cursor-ops");
  });

  it("routes news to news agent", () => {
    const r = router.route("今天有什么新闻");
    assert.ok(r);
    assert.equal(r.agent, "news");
  });

  it("returns null for unmatched messages", () => {
    const r = router.route("hello");
    assert.equal(r, null);
  });

  it("routes by fingerprint after recording history", () => {
    const r2 = new ZeroCostRouter();
    // Record same pattern 3 times
    r2.recordDelegation("deploy the kubernetes cluster", "coder", true, 500);
    r2.recordDelegation("deploy the kubernetes cluster", "coder", true, 600);
    r2.recordDelegation("deploy the kubernetes cluster", "coder", true, 550);
    // Similar message should match by fingerprint
    const result = r2.routeByFingerprint("deploy kubernetes cluster now");
    assert.ok(result);
    assert.equal(result.agent, "coder");
    assert.equal(result.method, "fingerprint");
  });

  it("promotes fingerprints to rules after 3 successes", () => {
    const r2 = new ZeroCostRouter([]);  // empty rules
    r2.recordDelegation("kubernetes deploy cluster", "coder", true);
    r2.recordDelegation("kubernetes deploy cluster", "coder", true);
    r2.recordDelegation("kubernetes deploy cluster", "coder", true);
    const promoted = r2.promoteToRules();
    assert.ok(promoted >= 1);
    assert.ok(r2.getRules().length >= 1);
  });
});

describe("FlowResolver", () => {
  const resolver = new FlowResolver();

  it("matches feature-dev template", () => {
    const plan = resolver.resolve("实现一个新功能：用户登录");
    assert.ok(plan);
    assert.equal(plan.template, "feature-dev");
    assert.ok(plan.waves.length >= 2);
  });

  it("matches code-review template", () => {
    const plan = resolver.resolve("review这个PR的代码");
    assert.ok(plan);
    assert.equal(plan.template, "code-review");
  });

  it("matches research-write template", () => {
    const plan = resolver.resolve("调研AI agent趋势并写一篇报告");
    assert.ok(plan);
    assert.equal(plan.template, "research-write");
  });

  it("returns null for non-matching messages", () => {
    const plan = resolver.resolve("hello world");
    assert.equal(plan, null);
  });

  it("topoSort produces correct waves", () => {
    const steps = [
      { id: "a", agent: "thinker", prompt: "step a", dependsOn: [] },
      { id: "b", agent: "coder", prompt: "step b", dependsOn: ["a"] },
      { id: "c", agent: "writer", prompt: "step c", dependsOn: ["a"] },
      { id: "d", agent: "coder", prompt: "step d", dependsOn: ["b", "c"] },
    ];
    const waves = resolver.topoSort(steps);
    assert.equal(waves.length, 3);
    assert.equal(waves[0].length, 1); // a
    assert.equal(waves[1].length, 2); // b, c (parallel)
    assert.equal(waves[2].length, 1); // d
  });

  it("topoSort handles all-independent steps in one wave", () => {
    const steps = [
      { id: "a", agent: "coder", prompt: "a", dependsOn: [] },
      { id: "b", agent: "writer", prompt: "b", dependsOn: [] },
      { id: "c", agent: "artist", prompt: "c", dependsOn: [] },
    ];
    const waves = resolver.topoSort(steps);
    assert.equal(waves.length, 1);
    assert.equal(waves[0].length, 3);
  });
});

describe("WaveExecutor", () => {
  it("executes waves in order with parallel steps", async () => {
    const executor = new WaveExecutor(0);
    const callLog = [];

    const plan = {
      template: "test",
      waves: [
        [{ id: "a", agent: "thinker", prompt: "analyze {{task}}", dependsOn: [] }],
        [
          { id: "b", agent: "coder", prompt: "implement {{a}}", dependsOn: ["a"] },
          { id: "c", agent: "writer", prompt: "document {{a}}", dependsOn: ["a"] },
        ],
      ],
    };

    const results = await executor.execute(plan, "build login", {
      dispatch: async (agent, prompt) => {
        callLog.push(`${agent}:${prompt.slice(0, 20)}`);
        return `output from ${agent}`;
      },
    });

    assert.equal(results.length, 3);
    assert.ok(results.every(r => r.success));
    // Wave 1 (thinker) should execute before wave 2
    assert.ok(callLog[0].startsWith("thinker"));
  });

  it("substitutes step outputs into downstream prompts", async () => {
    const executor = new WaveExecutor(0);
    const prompts = [];

    const plan = {
      template: "test",
      waves: [
        [{ id: "research", agent: "thinker", prompt: "research {{task}}", dependsOn: [] }],
        [{ id: "write", agent: "writer", prompt: "write about: {{research}}", dependsOn: ["research"] }],
      ],
    };

    await executor.execute(plan, "AI trends", {
      dispatch: async (_agent, prompt) => {
        prompts.push(prompt);
        return "research findings here";
      },
    });

    assert.ok(prompts[1].includes("research findings here"));
  });

  it("retries failed steps", async () => {
    const executor = new WaveExecutor(1);
    let attempts = 0;

    const plan = {
      template: "test",
      waves: [[{ id: "a", agent: "coder", prompt: "do it", dependsOn: [] }]],
    };

    const results = await executor.execute(plan, "task", {
      dispatch: async () => {
        attempts++;
        if (attempts === 1) throw new Error("transient");
        return "ok";
      },
    });

    assert.equal(attempts, 2);
    assert.ok(results[0].success);
  });

  it("stops on wave failure", async () => {
    const executor = new WaveExecutor(0);

    const plan = {
      template: "test",
      waves: [
        [{ id: "a", agent: "coder", prompt: "fail", dependsOn: [] }],
        [{ id: "b", agent: "writer", prompt: "never reached", dependsOn: ["a"] }],
      ],
    };

    const results = await executor.execute(plan, "task", {
      dispatch: async () => { throw new Error("boom"); },
    });

    assert.equal(results.length, 1); // wave 2 never executed
    assert.ok(!results[0].success);
  });
});

describe("LearningLoop", () => {
  it("records and tracks stats", () => {
    const router = new ZeroCostRouter([]);
    const learner = new LearningLoop(router, 5);

    learner.record("fix bug in app.ts", "coder", true, 300);
    learner.record("write readme", "writer", true, 200);

    const stats = learner.getStats();
    assert.equal(stats.totalDelegations, 2);
    assert.equal(stats.historySize, 2);
  });

  it("auto-promotes after interval", () => {
    const router = new ZeroCostRouter([]);
    const learner = new LearningLoop(router, 3);

    // 3 successes for same task
    learner.record("deploy kubernetes cluster", "coder", true);
    learner.record("deploy kubernetes cluster", "coder", true);
    learner.record("deploy kubernetes cluster", "coder", true);
    // Promotion happens at delegationCount % 3 === 0

    assert.ok(router.getRules().length >= 1);
  });
});

describe("FlowEngine", () => {
  const engine = new FlowEngine();

  it("returns flow plan for multi-step tasks", () => {
    const result = engine.plan("实现一个新功能：用户注册");
    assert.ok(result);
    assert.equal(result.type, "flow");
  });

  it("returns single route for simple tasks", () => {
    const result = engine.plan("fix the bug in parser.ts");
    assert.ok(result);
    assert.equal(result.type, "single");
    if (result.type === "single") {
      assert.equal(result.route.agent, "coder");
    }
  });

  it("returns null for unmatched tasks", () => {
    const result = engine.plan("hi");
    assert.equal(result, null);
  });

  it("shouldDelegate: false for short/chat messages", () => {
    assert.equal(engine.shouldDelegate("hi"), false);
    assert.equal(engine.shouldDelegate("你好"), false);
    assert.equal(engine.shouldDelegate("status"), false);
  });

  it("shouldDelegate: true for substantial tasks", () => {
    assert.equal(engine.shouldDelegate("帮我重构context-engine的storage层，优化查询性能"), true);
    assert.equal(engine.shouldDelegate("implement a new caching layer for the theme manager"), true);
  });
});
