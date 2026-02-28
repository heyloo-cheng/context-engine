/**
 * Context Engine v1.0 — Main Plugin Entry
 * Fuses xMemory (4-layer hierarchy) + MemWeaver (user profiling)
 * 
 * Hooks:
 *   before_prompt_build → top-down retrieval → inject systemPrompt
 *   agent_end → build episodes → extract semantics → assign themes
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OpenClawPluginApi = any;
import type { ContextEngineConfig, Message, Episode } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { StorageLayer } from "./layers/storage.js";
import { EpisodeBuilder } from "./layers/episode-builder.js";
import { SemanticExtractor } from "./layers/semantic-extractor.js";
import { ThemeManager } from "./layers/theme-manager.js";
import { TopDownRetriever } from "./layers/retriever.js";
import { UserProfiler } from "./layers/user-profiler.js";
import { DecayManager } from "./layers/decay-manager.js";
import { ObservabilityManager } from "./layers/observability.js";
import { FeedbackTuner } from "./layers/feedback-tuner.js";
import { PredictivePreloader } from "./layers/predictive-preloader.js";
import { CrossAgentSharing } from "./layers/cross-agent.js";
import { ThemeCache } from "./layers/theme-cache.js";
import { embedSingle } from "./utils/embedding.js";

// --- State ---
let storage: StorageLayer | null = null;
let episodeBuilder: EpisodeBuilder | null = null;
let semanticExtractor: SemanticExtractor | null = null;
let themeManager: ThemeManager | null = null;
let retriever: TopDownRetriever | null = null;
let userProfiler: UserProfiler | null = null;
let config: ContextEngineConfig = { ...DEFAULT_CONFIG };
let initialized = false;

// v1.1 modules
const observability = new ObservabilityManager();
const feedbackTuner = new FeedbackTuner();
const preloader = new PredictivePreloader();
const crossAgent = new CrossAgentSharing();
const themeCache = new ThemeCache();
const decayManager = new DecayManager();
// traces replaced by observability module

export default function contextEngine(api: OpenClawPluginApi) {
  const logger = api.logger;
  logger.info("[context-engine] v1.0.0 initializing — xMemory + MemWeaver fusion");

  // Resolve config
  const pluginConfig = (api as unknown as Record<string, unknown>).config as Partial<ContextEngineConfig> || {};
  config = { ...DEFAULT_CONFIG, ...pluginConfig };

  // Resolve paths
  if (!config.dbPath) {
    config.dbPath = process.env.LANCEDB_PATH || `${process.env.HOME}/.openclaw/memory/lancedb-pro`;
  }
  if (!config.jinaApiKey) {
    config.jinaApiKey = process.env.JINA_API_KEY || "";
  }

  if (!config.enabled) {
    logger.info("[context-engine] Disabled by config");
    return;
  }

  // --- Lazy Init ---
  async function ensureInit(): Promise<boolean> {
    if (initialized) return true;
    if (!config.jinaApiKey) {
      logger.warn("[context-engine] No Jina API key, skipping init");
      return false;
    }
    try {
      storage = new StorageLayer(config.dbPath);
      await storage.init();

      episodeBuilder = new EpisodeBuilder({
        batchSize: config.episodeBatchSize,
        jinaApiKey: config.jinaApiKey,
      });

      semanticExtractor = new SemanticExtractor({
        jinaApiKey: config.jinaApiKey,
      });

      themeManager = new ThemeManager({
        jinaApiKey: config.jinaApiKey,
      });

      retriever = new TopDownRetriever({
        storage,
        tokenBudget: config.tokenBudget,
      });

      userProfiler = new UserProfiler({
        jinaApiKey: config.jinaApiKey,
      });

      initialized = true;
      const stats = await storage.getStats();
      logger.info(`[context-engine] Initialized. Tables: ${JSON.stringify(stats)}`);
      return true;
    } catch (err) {
      logger.warn(`[context-engine] Init failed: ${err}`);
      return false;
    }
  }

  // --- LLM Helper ---
  // Uses the agent's own LLM for cheap calls (haiku-level)
  function createLlmCall(ctx: unknown): (prompt: string) => Promise<string> {
    return async (prompt: string) => {
      // Try to use the plugin API's LLM access
      const apiAny = api as unknown as Record<string, unknown>;
      if (typeof apiAny.llm === "function") {
        return await (apiAny.llm as (p: string) => Promise<string>)(prompt);
      }
      // Fallback: return empty (graceful degradation)
      logger.warn("[context-engine] No LLM access, returning empty");
      return "";
    };
  }

  // ================================================================
  // Hook: before_prompt_build — Top-down retrieval → inject systemPrompt
  // ================================================================
  api.on("before_prompt_build", async (event: any, ctx: any) => {
    if (!(await ensureInit()) || !retriever || !storage) return undefined;

    const { prompt } = event;
    if (!prompt || prompt.length < 4) return undefined;

    try {
      // v1.1: Mark previous retrieval as unsatisfied if user asks follow-up on same topic
      const lastTraces = observability.getTraces();
      if (lastTraces.length > 0) {
        const last = lastTraces[lastTraces.length - 1];
        const timeDiff = Date.now() - last.timestamp;
        if (timeDiff < 60000) { // within 1 min = likely follow-up
          observability.markSatisfaction(false);
        } else {
          observability.markSatisfaction(true);
        }
      }

      // Embed the query
      const queryEmbedding = await embedSingle(prompt, config.jinaApiKey, "query");

      // Two-stage retrieval
      const llmCall = createLlmCall(ctx);
      const result = await retriever.retrieve(queryEmbedding, prompt, llmCall);

      if (result.semantics.length === 0 && result.themes.length === 0) {
        return undefined;
      }

      // Build systemPrompt injection
      const parts: string[] = [];

      // 1. Theme overview (~50 tokens)
      if (result.themes.length > 0) {
        parts.push("## Active Context");
        parts.push(`Current topics: ${result.themes.map(t => t.name).join(", ")}`);
      }

      // 2. User profile (~100 tokens)
      const profile = await storage.getLatestProfile("default");
      if (profile?.global_profile) {
        parts.push("## User Profile");
        parts.push(profile.global_profile);
      }

      // 3. Semantic facts (~150 tokens)
      if (result.semantics.length > 0) {
        parts.push("## Relevant Facts");
        for (const s of result.semantics.slice(0, 8)) {
          parts.push(`- ${s.content}`);
        }
      }

      // 4. Episode details (if expanded, ~200 tokens)
      if (result.episodes.length > 0) {
        parts.push("## Details");
        for (const e of result.episodes.slice(0, 3)) {
          parts.push(`- ${e.summary}`);
        }
      }

      // v1.1: Observability trace
      const trace = observability.buildTrace(prompt, result);
      observability.record(trace);

      logger.info(
        `[context-engine] Injected: ${result.themes.length} themes, ` +
        `${result.semantics.length} semantics, ${result.episodes.length} episodes, ` +
        `~${result.total_tokens} tokens, decision=${result.stage2_decision}`
      );

      return {
        systemPrompt: "\n" + parts.join("\n"),
      };
    } catch (err) {
      logger.warn(`[context-engine] Retrieval error: ${err}`);
      return undefined;
    }
  });

  // ================================================================
  // Hook: agent_end — Build episodes → extract semantics → assign themes
  // ================================================================
  api.on("agent_end", async (event: any, ctx: any) => {
    if (!(await ensureInit()) || !episodeBuilder || !semanticExtractor || !themeManager || !storage) return;

    try {
      const messages: Message[] = ((event as Record<string, unknown>).messages as Message[]) || [];
      if (messages.length === 0) return;

      // Add messages to episode builder (with topic switch detection)
      const llmCall = createLlmCall(ctx);
      let prevMsg: Message | null = null;
      for (const msg of messages) {
        if (prevMsg && episodeBuilder.detectTopicSwitch(msg, prevMsg)) {
          // Topic switch: force flush current episode before adding new msg
          if (episodeBuilder.hasPending()) {
            const earlyEp = await episodeBuilder.flush(llmCall);
            if (earlyEp) {
              await storage.addEpisode(earlyEp as Episode & { embedding: number[] });
              logger.info(`[context-engine] Topic switch → episode ${earlyEp.episode_id}`);
            }
          }
        }
        episodeBuilder.addMessage(msg);
        prevMsg = msg;
      }

      // Flush if we have enough messages
      if (!episodeBuilder.hasPending()) return;

      const episode = await episodeBuilder.flush(llmCall);
      if (!episode) return;

      // Store episode
      await storage.addEpisode(episode as Episode & { embedding: number[] });
      logger.info(`[context-engine] Episode created: ${episode.episode_id} (${episode.message_count} msgs)`);

      // Extract semantics from episode
      const existingSemantics = await storage.searchSemantics(
        (episode as Episode & { embedding: number[] }).embedding, 20
      );
      const newSemantics = await semanticExtractor.extract(
        episode, existingSemantics, llmCall
      );

      // Assign each semantic to a theme
      const allThemes = await storage.getAllThemes();
      for (const semantic of newSemantics) {
        const { themeId, isNew, newTheme } = await themeManager.assignToTheme(
          semantic, allThemes, llmCall
        );

        semantic.theme_id = themeId;
        await storage.addSemantic(semantic);

        if (isNew && newTheme) {
          await storage.addTheme(newTheme);
          allThemes.push(newTheme);
          logger.info(`[context-engine] New theme: "${newTheme.name}" (${newTheme.theme_id})`);
        } else {
          // Update existing theme's semantic_ids
          const theme = allThemes.find(t => t.theme_id === themeId);
          if (theme) {
            theme.semantic_ids.push(semantic.semantic_id);
            theme.message_count++;
            theme.last_active = Date.now();
            await storage.updateTheme(themeId, {
              semantic_ids: theme.semantic_ids,
              message_count: theme.message_count,
              last_active: theme.last_active,
            });

            // Check if theme needs splitting
            if (themeManager.shouldSplit(theme)) {
              const themeSems = await storage.getSemanticsByTheme(themeId);
              const semsWithEmbed = themeSems.filter(s => s.embedding) as (typeof newSemantics[0])[];
              if (semsWithEmbed.length > 0) {
                const { theme1, theme2 } = await themeManager.splitTheme(
                  theme, semsWithEmbed, llmCall
                );
                await storage.addTheme(theme1);
                await storage.addTheme(theme2);
                await storage.deleteTheme(themeId);
                logger.info(`[context-engine] Theme split: "${theme.name}" → "${theme1.name}" + "${theme2.name}"`);
              }
            }

            // Check if theme needs merging with a neighbor
            for (const neighborId of (theme.knn_neighbors || [])) {
              const neighbor = allThemes.find(t => t.theme_id === neighborId);
              if (neighbor && themeManager.shouldMerge(theme, neighbor)) {
                const merged = themeManager.mergeThemes(theme, neighbor);
                await storage.updateTheme(merged.theme_id, {
                  summary: merged.summary,
                  semantic_ids: merged.semantic_ids,
                  message_count: merged.message_count,
                  last_active: merged.last_active,
                });
                await storage.deleteTheme(neighborId);
                logger.info(`[context-engine] Theme merged: "${neighbor.name}" into "${theme.name}"`);
                break;
              }
            }
          }
        }

        logger.info(`[context-engine] Semantic: "${semantic.content.slice(0, 40)}..." → theme ${themeId}`);
      }

      // Update kNN graph and persist
      const updatedThemes = await storage.getAllThemes();
      themeManager.updateKNN(updatedThemes);
      for (const t of updatedThemes) {
        await storage.updateTheme(t.theme_id, { knn_neighbors: t.knn_neighbors });
      }

    } catch (err) {
      logger.warn(`[context-engine] Build error: ${err}`);
    }
  });

  // ================================================================
  // Cron: Weekly user profile update + theme health check
  // ================================================================
  if (typeof api.on === "function") {
    api.on("cron_weekly", async (_event: any, ctx: any) => {
      if (!(await ensureInit()) || !userProfiler || !themeManager || !storage) return;
      const llmCall = createLlmCall(ctx);

      try {
        // 1. Generate phase profile
        const phase = UserProfiler.getCurrentPhase();
        const allEpisodes = await storage.searchEpisodes(new Array(1024).fill(0), 100);
        const allSemantics = await storage.searchSemantics(new Array(1024).fill(0), 100);

        const profile = await userProfiler.generatePhaseProfile(
          "default", phase, allEpisodes, allSemantics, llmCall
        );

        // Merge global profile from all phases
        const latest = await storage.getLatestProfile("default");
        const phases = latest ? [latest, profile] : [profile];
        profile.global_profile = await userProfiler.mergeGlobalProfile(phases, llmCall);

        await storage.addProfile(profile);
        logger.info(`[context-engine] Profile updated: phase=${phase}`);

        // 2. Theme health check: mark dormant themes
        const themes = await storage.getAllThemes();
        const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
        for (const theme of themes) {
          if (theme.last_active < thirtyDaysAgo) {
            await storage.updateTheme(theme.theme_id, { summary: `[dormant] ${theme.summary}` });
            logger.info(`[context-engine] Theme dormant: "${theme.name}"`);
          }
        }

        // 3. Semantic dedup sweep
        const sems = await storage.searchSemantics(new Array(1024).fill(0), 200);
        for (let i = 0; i < sems.length; i++) {
          for (let j = i + 1; j < sems.length; j++) {
            if (sems[i].embedding && sems[j].embedding) {
              const { cosineDistance } = await import("./utils/embedding.js");
              if (cosineDistance(sems[i].embedding!, sems[j].embedding!) < 0.1) {
                // Merge: keep i, delete j
                await storage.deleteSemantic(sems[j].semantic_id);
                logger.info(`[context-engine] Dedup: merged "${sems[j].content.slice(0, 30)}..."`);
              }
            }
          }
        }
        // 4. Decay sweep (Section 6.4)
        await decayManager.sweep(storage, logger);
        logger.info("[context-engine] Decay sweep done");

        // 5. Rebuild preload rules (Section 6.3)
        await preloader.buildRules(storage);
        logger.info(`[context-engine] Preload rules: ${preloader.getRules().length}`);

        // 6. Adjust retrieval α from feedback (Section 6.2)
        feedbackTuner.adjust(observability.getTraces());
        logger.info(`[context-engine] Feedback α=${feedbackTuner.getAlpha().toFixed(3)}`);

      } catch (err) {
        logger.warn(`[context-engine] Cron error: ${err}`);
      }
    });
  }

  logger.info("[context-engine] v1.1.0 registered: before_prompt_build + agent_end + cron_weekly hooks");
}
