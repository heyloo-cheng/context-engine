/**
 * Episode Builder — Layer A foundation
 * Converts batches of raw messages into episode summaries
 * Uses haiku for cheap summarization (~$0.001/call)
 */

import type { Episode, Message } from "../types.js";
import { embedSingle, generateId } from "../utils/embedding.js";

const HAIKU_SUMMARIZE_PROMPT = `You are a conversation summarizer. Given a batch of messages, produce a concise summary (50-100 tokens) that captures:
1. What was discussed
2. Key decisions made
3. Actions taken or planned

Output ONLY the summary, no preamble. Write in the same language as the messages.`;

export class EpisodeBuilder {
  private pendingMessages: Message[] = [];
  private turnCounter = 0;
  private batchSize: number;
  private sessionId: string;
  private jinaApiKey: string;

  constructor(opts: { batchSize?: number; sessionId?: string; jinaApiKey: string }) {
    this.batchSize = opts.batchSize || 5;
    this.sessionId = opts.sessionId || "default";
    this.jinaApiKey = opts.jinaApiKey;
  }

  /**
   * Add a message. Returns an Episode if batch is full.
   */
  addMessage(msg: Message): boolean {
    this.pendingMessages.push({ ...msg, timestamp: msg.timestamp || Date.now() });
    this.turnCounter++;
    return this.pendingMessages.length >= this.batchSize;
  }

  /**
   * Check if there are pending messages
   */
  hasPending(): boolean {
    return this.pendingMessages.length > 0;
  }

  /**
   * Force flush pending messages into an episode
   */
  async flush(summarize: (text: string) => Promise<string>): Promise<Episode | null> {
    if (this.pendingMessages.length === 0) return null;

    const messages = [...this.pendingMessages];
    const turnStart = this.turnCounter - messages.length;
    const turnEnd = this.turnCounter - 1;

    // Build text for summarization
    const text = messages
      .map((m) => `[${m.role}]: ${m.content.slice(0, 300)}`)
      .join("\n");

    // Summarize with haiku
    const summary = await summarize(
      `${HAIKU_SUMMARIZE_PROMPT}\n\n---\n${text}`
    );

    // Embed the summary
    const embedding = await embedSingle(summary, this.jinaApiKey);

    const episode: Episode & { embedding: number[] } = {
      episode_id: generateId(),
      summary,
      turn_start: turnStart,
      turn_end: turnEnd,
      message_count: messages.length,
      session_id: this.sessionId,
      created_at: Date.now(),
      embedding,
      raw_messages: JSON.stringify(
        messages.map((m) => ({ role: m.role, content: m.content.slice(0, 500) }))
      ),
    };

    // Clear pending
    this.pendingMessages = [];

    return episode;
  }

  /**
   * Detect topic switch — force flush if topic changed
   */
  detectTopicSwitch(currentMsg: Message, previousMsg: Message | null): boolean {
    if (!previousMsg) return false;
    // Simple heuristic: if roles alternate and content similarity is low
    // More sophisticated: use embedding similarity
    const curr = currentMsg.content.toLowerCase();
    const prev = previousMsg.content.toLowerCase();
    // Check for explicit topic markers
    const topicMarkers = [
      /换个话题|另外|顺便|by the way|btw|speaking of|另一个问题/i,
    ];
    return topicMarkers.some((r) => r.test(curr));
  }
}
