/**
 * Jina Embedding Utility
 * Uses Jina v5 text-small (1024 dims) for vectorization
 */

const JINA_API_URL = "https://api.jina.ai/v1/embeddings";

export async function embed(
  texts: string[],
  apiKey: string,
  model = "jina-embeddings-v5-text-small",
  task = "text-matching"
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const resp = await fetch(JINA_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input: texts, task }),
  });

  if (!resp.ok) {
    throw new Error(`Jina embed failed: ${resp.status} ${await resp.text()}`);
  }

  const data = (await resp.json()) as {
    data: { embedding: number[] }[];
  };
  return data.data.map((d) => d.embedding);
}

export async function embedSingle(
  text: string,
  apiKey: string,
  task = "text-matching"
): Promise<number[]> {
  const results = await embed([text], apiKey, undefined, task);
  return results[0];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
}

export function cosineDistance(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b);
}

export function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
