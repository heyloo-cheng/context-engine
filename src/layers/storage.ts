/**
 * LanceDB Storage Layer
 * Manages 4 new tables: themes, semantics, episodes, user_profile
 * Coexists with existing: memories, skills, semantic_cache
 */

import type { Theme, Semantic, Episode, UserProfile } from "../types.js";

// LanceDB connection interface (compatible with memory-lancedb-pro's db)
interface LanceTable {
  add(data: Record<string, unknown>[]): Promise<void>;
  search(vector: number[]): { limit(n: number): { execute(): Promise<Record<string, unknown>[]> } };
  filter(expr: string): { execute(): Promise<Record<string, unknown>[]> };
  update(opts: { where: string; values: Record<string, unknown> }): Promise<void>;
  delete(where: string): Promise<void>;
  countRows(): Promise<number>;
}

interface LanceDB {
  openTable(name: string): Promise<LanceTable>;
  createTable(name: string, data: Record<string, unknown>[]): Promise<LanceTable>;
  tableNames(): Promise<string[]>;
}

export class StorageLayer {
  private db: LanceDB | null = null;
  private tables: Map<string, LanceTable> = new Map();
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    // Dynamic import lancedb
    // @ts-ignore — vectordb resolved at runtime by OpenClaw's node_modules
    const lancedb = await import(/* webpackIgnore: true */ "vectordb");
    this.db = await (lancedb as any).connect(this.dbPath) as unknown as LanceDB;
    await this.ensureTables();
  }

  private async ensureTables(): Promise<void> {
    if (!this.db) throw new Error("DB not initialized");
    const existing = await this.db.tableNames();
    const dim = 1024; // Jina v5 text-small
    const zeroVec = new Array(dim).fill(0);

    // Create tables if not exist
    for (const name of ["themes", "semantics", "episodes", "user_profile"]) {
      if (!existing.includes(name)) {
        const seed = this.getSeedRecord(name, zeroVec);
        const table = await this.db.createTable(name, [seed]);
        this.tables.set(name, table);
        // Delete seed record
        await table.delete("_seed = true");
      } else {
        this.tables.set(name, await this.db.openTable(name));
      }
    }
  }

  private getSeedRecord(table: string, zeroVec: number[]): Record<string, unknown> {
    const base = { _seed: true, embedding: zeroVec };
    switch (table) {
      case "themes":
        return { ...base, theme_id: "_seed", name: "", summary: "", semantic_ids: "[]", message_count: 0, last_active: 0, knn_neighbors: "[]" };
      case "semantics":
        return { ...base, semantic_id: "_seed", theme_id: "", content: "", episode_ids: "[]", created_at: 0, updated_at: 0, knn_neighbors: "[]" };
      case "episodes":
        return { ...base, episode_id: "_seed", summary: "", turn_start: 0, turn_end: 0, message_count: 0, session_id: "", created_at: 0, raw_messages: "[]" };
      case "user_profile":
        return { ...base, profile_id: "_seed", user_id: "", phase: "", behavioral: "", cognitive: "", global_profile: "", updated_at: 0 };
      default:
        return base;
    }
  }

  // --- Theme Operations ---

  async addTheme(theme: Theme & { embedding: number[] }): Promise<void> {
    const table = this.tables.get("themes")!;
    await table.add([{
      ...theme,
      semantic_ids: JSON.stringify(theme.semantic_ids),
      knn_neighbors: JSON.stringify(theme.knn_neighbors),
    }]);
  }

  async searchThemes(vector: number[], limit = 3): Promise<Theme[]> {
    const table = this.tables.get("themes")!;
    const results = await table.search(vector).limit(limit).execute();
    return results.map(r => ({
      ...r,
      semantic_ids: JSON.parse(r.semantic_ids as string || "[]"),
      knn_neighbors: JSON.parse(r.knn_neighbors as string || "[]"),
    })) as unknown as Theme[];
  }

  async getAllThemes(): Promise<Theme[]> {
    const table = this.tables.get("themes")!;
    const results = await table.filter("theme_id != '_seed'").execute();
    return results.map(r => ({
      ...r,
      semantic_ids: JSON.parse(r.semantic_ids as string || "[]"),
      knn_neighbors: JSON.parse(r.knn_neighbors as string || "[]"),
    })) as unknown as Theme[];
  }

  async updateTheme(themeId: string, updates: Partial<Theme>): Promise<void> {
    const table = this.tables.get("themes")!;
    const values: Record<string, unknown> = { ...updates };
    if (updates.semantic_ids) values.semantic_ids = JSON.stringify(updates.semantic_ids);
    if (updates.knn_neighbors) values.knn_neighbors = JSON.stringify(updates.knn_neighbors);
    await table.update({ where: `theme_id = '${themeId}'`, values });
  }

  async deleteTheme(themeId: string): Promise<void> {
    const table = this.tables.get("themes")!;
    await table.delete(`theme_id = '${themeId}'`);
  }

  // --- Semantic Operations ---

  async addSemantic(semantic: Semantic & { embedding: number[] }): Promise<void> {
    const table = this.tables.get("semantics")!;
    await table.add([{
      ...semantic,
      episode_ids: JSON.stringify(semantic.episode_ids),
      knn_neighbors: JSON.stringify(semantic.knn_neighbors),
    }]);
  }

  async searchSemantics(vector: number[], limit = 10): Promise<Semantic[]> {
    const table = this.tables.get("semantics")!;
    const results = await table.search(vector).limit(limit).execute();
    return results.map(r => ({
      ...r,
      episode_ids: JSON.parse(r.episode_ids as string || "[]"),
      knn_neighbors: JSON.parse(r.knn_neighbors as string || "[]"),
    })) as unknown as Semantic[];
  }

  async getSemanticsByTheme(themeId: string): Promise<Semantic[]> {
    const table = this.tables.get("semantics")!;
    const results = await table.filter(`theme_id = '${themeId}'`).execute();
    return results.map(r => ({
      ...r,
      episode_ids: JSON.parse(r.episode_ids as string || "[]"),
      knn_neighbors: JSON.parse(r.knn_neighbors as string || "[]"),
    })) as unknown as Semantic[];
  }

  async deleteSemantic(semanticId: string): Promise<void> {
    const table = this.tables.get("semantics")!;
    await table.delete(`semantic_id = '${semanticId}'`);
  }

  // --- Episode Operations ---

  async addEpisode(episode: Episode & { embedding: number[] }): Promise<void> {
    const table = this.tables.get("episodes")!;
    await table.add([{ ...episode } as unknown as Record<string, unknown>]);
  }

  async searchEpisodes(vector: number[], limit = 5): Promise<Episode[]> {
    const table = this.tables.get("episodes")!;
    const results = await table.search(vector).limit(limit).execute();
    return results as unknown as Episode[];
  }

  async getEpisodesByIds(ids: string[]): Promise<Episode[]> {
    if (ids.length === 0) return [];
    const table = this.tables.get("episodes")!;
    const conditions = ids.map(id => `episode_id = '${id}'`).join(" OR ");
    const results = await table.filter(conditions).execute();
    return results as unknown as Episode[];
  }

  async deleteEpisode(episodeId: string): Promise<void> {
    const table = this.tables.get("episodes")!;
    await table.delete(`episode_id = '${episodeId}'`);
  }

  async updateEpisode(episodeId: string, updates: Partial<Record<string, unknown>>): Promise<void> {
    const table = this.tables.get("episodes")!;
    await table.update({ where: `episode_id = '${episodeId}'`, values: updates });
  }

  // --- User Profile Operations ---

  async addProfile(profile: UserProfile & { embedding: number[] }): Promise<void> {
    const table = this.tables.get("user_profile")!;
    await table.add([{ ...profile } as unknown as Record<string, unknown>]);
  }

  async getLatestProfile(userId: string): Promise<UserProfile | null> {
    const table = this.tables.get("user_profile")!;
    const results = await table.filter(`user_id = '${userId}'`).execute();
    if (results.length === 0) return null;
    // Sort by updated_at desc, return latest
    const sorted = results.sort((a, b) => (b.updated_at as number) - (a.updated_at as number));
    return sorted[0] as unknown as UserProfile;
  }

  // --- Stats ---

  async getStats(): Promise<Record<string, number>> {
    const stats: Record<string, number> = {};
    for (const [name, table] of this.tables) {
      stats[name] = await table.countRows();
    }
    return stats;
  }
}
