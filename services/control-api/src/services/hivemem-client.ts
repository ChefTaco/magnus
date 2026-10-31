/**
 * hivemem-client.ts — Lightweight HiveMem API client for the Control API.
 *
 * Used by AI tools (storeMemory, recallMemories, forgetMemory) and
 * the system prompt memory injection. Talks to hive-mem over HTTPS.
 */

import { loadEnv } from '../config/env.js';

export interface HiveMemMemory {
  content: string;
  type: 'episodic' | 'semantic';
  scope: 'shared' | 'private';
  source: string;
  confidence?: number;
  importance?: number;
  tags?: string[];
}

export interface HiveMemRecord {
  id: string;
  agent_id: string;
  content: string;
  type: string;
  scope: string;
  source: string;
  confidence: number;
  effective_confidence: number;
  importance: number;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface HiveMemSearchResult {
  id: string;
  content: string;
  score: number;
  effective_confidence: number;
  type: string;
  scope: string;
  source: string;
  tags: string[];
  agent_id: string;
  created_at: string;
}

export class HiveMemError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HiveMemError';
  }
}

export class HiveMemClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl?: string, token?: string) {
    const env = loadEnv();
    this.baseUrl = (baseUrl ?? env.HIVEMEM_URL ?? '').replace(/\/+$/, '');
    this.token = token ?? env.HIVEMEM_TOKEN ?? '';
  }

  get configured(): boolean {
    return Boolean(this.baseUrl && this.token);
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...options.headers,
        },
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new HiveMemError(res.status, `HiveMem ${res.status}: ${body}`);
      }

      // 204 No Content
      if (res.status === 204) return undefined as T;

      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async storeMemory(memory: HiveMemMemory): Promise<HiveMemRecord> {
    return this.request<HiveMemRecord>('/v1/memories', {
      method: 'POST',
      body: JSON.stringify(memory),
    });
  }

  async searchMemories(query: string, limit = 20): Promise<HiveMemSearchResult[]> {
    const res = await this.request<{ results: HiveMemSearchResult[] }>('/v1/memories/search', {
      method: 'POST',
      body: JSON.stringify({ query, limit }),
    });
    return res.results;
  }

  async browseMemories(limit = 50, offset = 0): Promise<{ memories: HiveMemRecord[]; total: number }> {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    return this.request(`/v1/memories/browse?${params.toString()}`);
  }

  async deleteMemory(id: string): Promise<void> {
    await this.request(`/v1/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async checkHealth(): Promise<{ status: string; collections: number }> {
    return this.request('/v1/health');
  }
}

/** Singleton instance — lazy-init on first use. */
let _client: HiveMemClient | null = null;
export function getHiveMemClient(): HiveMemClient {
  if (!_client) _client = new HiveMemClient();
  return _client;
}
