/**
 * Context Engine v1.0 — Type Definitions
 * Based on xMemory (4-layer hierarchy) + MemWeaver (dual-component user profile)
 */

// --- Layer A: xMemory 4-Layer Hierarchy ---

export interface Theme {
  theme_id: string;
  name: string;
  summary: string;
  semantic_ids: string[];
  message_count: number;
  last_active: number;
  embedding?: number[];
  knn_neighbors: string[];
}

export interface Semantic {
  semantic_id: string;
  theme_id: string;
  content: string;
  episode_ids: string[];
  created_at: number;
  updated_at: number;
  embedding?: number[];
  knn_neighbors: string[];
}

export interface Episode {
  episode_id: string;
  summary: string;
  turn_start: number;
  turn_end: number;
  message_count: number;
  session_id: string;
  created_at: number;
  embedding?: number[];
  raw_messages: string; // JSON stringified
}

// --- Layer B: MemWeaver User Profile ---

export interface UserProfile {
  profile_id: string;
  user_id: string;
  phase: string; // e.g. "2026-02-W4"
  behavioral: string; // what user did this phase
  cognitive: string; // preferences/habits/style
  global_profile: string; // merged from all phases
  updated_at: number;
  embedding?: number[];
}

// --- Retrieval ---

export interface RetrievalResult {
  themes: Theme[];
  semantics: Semantic[];
  episodes: Episode[];
  stage2_decision: "YES" | "PARTIAL" | "NO";
  total_tokens: number;
}

export interface RetrievalTrace {
  query: string;
  timestamp: number;
  matched_themes: string[];
  selected_semantics: string[];
  expanded_episodes: string[];
  stage2_decision: string;
  total_tokens_injected: number;
}

// --- v1.1: Observability Trace (Section 6.6) ---

export interface ObservabilityTrace extends RetrievalTrace {
  user_satisfaction: "satisfied" | "unsatisfied" | "unknown";
  agent_id?: string;
}

// --- v1.1: Decay Config (Section 6.4) ---

export interface DecayConfig {
  themeHalfLifeDays: number;    // default: Infinity (never forget)
  semanticHalfLifeDays: number; // default: 180
  episodeHalfLifeDays: number;  // default: 30
  messageRetainDays: number;    // default: 7 (then delete raw_messages)
}

export const DEFAULT_DECAY: DecayConfig = {
  themeHalfLifeDays: Infinity,
  semanticHalfLifeDays: 180,
  episodeHalfLifeDays: 30,
  messageRetainDays: 7,
};

// --- v1.1: Preload Rule (Section 6.3) ---

export interface PreloadRule {
  dayOfWeek: number;  // 0=Sun..6=Sat
  hourStart: number;
  hourEnd: number;
  themeIds: string[];
}

// --- Config ---

export interface ContextEngineConfig {
  enabled: boolean;
  maxThemes: number;
  episodeBatchSize: number;
  tokenBudget: number;
  jinaApiKey: string;
  jinaModel: string;
  dbPath: string;
}

export const DEFAULT_CONFIG: ContextEngineConfig = {
  enabled: true,
  maxThemes: 50,
  episodeBatchSize: 5,
  tokenBudget: 500,
  jinaApiKey: "",
  jinaModel: "jina-embeddings-v5-text-small",
  dbPath: "",
};

// --- Messages ---

export interface Message {
  role: string;
  content: string;
  timestamp?: number;
}
