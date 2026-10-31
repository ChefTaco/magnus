/**
 * Server-side fetch helper for Orchestra (Hermes fleet) — used by RSC.
 *
 * Routes through the active control-plane node and uses its API secret. All
 * Orchestra resource endpoints (skills, toolsets, providers, credential
 * pools, MCP, messaging, cron, plugins, hooks, installations, profiles, …)
 * live under /api/v1/orchestra/* on magnus-api.
 */
import { cookies } from 'next/headers';
import { controlNodeFetchById } from '@/lib/control-node-server';
import { readNodes } from '@/lib/control-nodes-store';

const ACTIVE_NODE_COOKIE = 'magnus_active_node_id';
type SearchParamValue = string | number | boolean | null | undefined;

interface ResolvedNode {
  id: string;
}

export interface OrchestraFetchInit extends Omit<RequestInit, 'body'> {
  body?: BodyInit | Record<string, unknown> | unknown[] | null;
  searchParams?: URLSearchParams | Record<string, SearchParamValue | SearchParamValue[]>;
}

export interface OrchestraMutationResult<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
  status?: number;
}

export class OrchestraFetchError extends Error {
  status: number;
  data: unknown;
  url: string;

  constructor(message: string, status: number, url: string, data: unknown) {
    super(message);
    this.name = 'OrchestraFetchError';
    this.status = status;
    this.url = url;
    this.data = data;
  }
}

async function resolveActiveNode(): Promise<ResolvedNode> {
  const cookieStore = await cookies();
  const activeNodeId = cookieStore.get(ACTIVE_NODE_COOKIE)?.value ?? 'local';
  if (activeNodeId === 'local') return { id: 'local' };
  const nodes = await readNodes();
  if (!nodes.some((node) => node.id === activeNodeId)) {
    throw new Error(`Selected control node '${activeNodeId}' is unavailable`);
  }
  return { id: activeNodeId };
}

function appendSearchParams(url: URL, searchParams: OrchestraFetchInit['searchParams']): void {
  if (!searchParams) return;
  if (searchParams instanceof URLSearchParams) {
    searchParams.forEach((value, key) => url.searchParams.append(key, value));
    return;
  }

  for (const [key, rawValue] of Object.entries(searchParams)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value !== null && value !== undefined) url.searchParams.append(key, String(value));
    }
  }
}

function isBodyInit(body: unknown): body is BodyInit {
  return (
    typeof body === 'string' ||
    body instanceof ArrayBuffer ||
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof ReadableStream
  );
}

async function readPayload(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorMessage(data: unknown, status: number): string {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const error = record['error'];
    const message = record['message'];
    if (typeof error === 'string') return error;
    if (typeof message === 'string') return message;
    if (error && typeof error === 'object') {
      const nestedMessage = (error as Record<string, unknown>)['message'];
      if (typeof nestedMessage === 'string') return nestedMessage;
    }
  }
  if (typeof data === 'string' && data.trim()) return data;
  return `Orchestra fetch failed with HTTP ${status}`;
}

export async function orchestraFetch<T>(path: string, init?: OrchestraFetchInit): Promise<T> {
  const node = await resolveActiveNode();
  const relativePath = `orchestra/${path.replace(/^\//, '')}`;
  const url = new URL(`https://placeholder.invalid/api/v1/${relativePath}`);
  appendSearchParams(url, init?.searchParams);

  const headers = new Headers(init?.headers);
  const body = init?.body;
  let requestBody: BodyInit | undefined;
  if (body !== undefined && body !== null) {
    if (isBodyInit(body)) {
      requestBody = body;
    } else {
      requestBody = JSON.stringify(body);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    }
  }

  const res = await controlNodeFetchById(node.id, `${relativePath}${url.search}`, {
    ...init,
    body: requestBody,
    headers,
    cache: 'no-store',
  });

  if (!res.ok) {
    const data = await readPayload(res);
    throw new OrchestraFetchError(errorMessage(data, res.status), res.status, relativePath, data);
  }

  return readPayload(res) as Promise<T>;
}

export async function orchestraMutation<T>(
  path: string,
  init: Pick<OrchestraFetchInit, 'method' | 'body' | 'searchParams' | 'headers'>,
): Promise<OrchestraMutationResult<T>> {
  try {
    const data = await orchestraFetch<T>(path, init);
    return { ok: true, data, error: null };
  } catch (err) {
    if (err instanceof OrchestraFetchError) {
      return { ok: false, data: null, error: err.message, status: err.status };
    }
    return { ok: false, data: null, error: err instanceof Error ? err.message : 'Unknown Orchestra error' };
  }
}
