# Context Engine v1.0

> xMemory (ICML 2026) + MemWeaver (WWW'26) fusion for OpenClaw
> 4-layer hierarchical memory with top-down retrieval and user profiling

## Architecture

```
Messages → Episode → Semantic → Theme (xMemory 4-layer)
                                  +
         Behavioral Memory + Cognitive Memory (MemWeaver)
                                  +
         fact/decision dual-layer (existing LanceDB)
```

## How It Works

**Building (after each conversation):**
1. Raw messages → Episode summaries (haiku, ~$0.001)
2. Episodes → Semantic facts extraction (haiku, ~$0.001)
3. Semantics → Theme assignment (vector similarity)
4. Theme auto split/merge (sparsity-semantics guidance)

**Retrieval (before each response):**
1. Stage I: Query → top themes → relevant semantics (breadth)
2. Stage II: Are semantics enough? YES→done, PARTIAL→expand episodes, NO→expand messages
3. Inject into systemPrompt (invisible to user)

## LanceDB Tables

| Table | Purpose | Layer |
|-------|---------|-------|
| themes | Topic clusters (bird's-eye view) | xMemory L3 |
| semantics | Reusable facts | xMemory L2 |
| episodes | Conversation segment summaries | xMemory L1 |
| user_profile | Behavioral + cognitive memory | MemWeaver |
| memories | fact/decision (existing) | Layer C |
| skills | 75 skill vectors (existing) | Layer C |
| semantic_cache | Query cache (existing) | Layer C |

## Install

```bash
cd ~/.openclaw/workspace/plugins/context-engine
npm install && npm run build
openclaw plugins install -l .
openclaw gateway restart
```

## Config

Set `JINA_API_KEY` environment variable for embedding.

## Cost

~$0.05/day (20 conversations), ~$1.5/month

## Papers

- xMemory: [arxiv 2602.02007](https://arxiv.org/abs/2602.02007) (ICML 2026)
- MemWeaver: [arxiv 2510.07713](https://arxiv.org/abs/2510.07713) (WWW'26)

## License

MIT
