/**
 * The Emberpath client key of an agent New Agent creates with an Emberpath alias.
 *
 * Emberpath answers `/v1` only with a client key, and issuing one is a credential write that Emberpath
 * allows only a person who signed in recently (its step-up); it refuses service tokens. So Magnus does
 * not issue keys: the operator creates one in Emberpath and hands it to New Agent, which checks it
 * against Emberpath here, holds it in this process's memory only until the `config-save` step has
 * written it to the new profile's `.env`, and never stores, logs, audits or returns it.
 */
import { HttpError } from '../middleware/error-handler.js';

/** Why New Agent refuses an alias model without a key. Shared by New Agent and the definition preflight. */
export const EMBERPATH_KEY_MISSING = 'Emberpath key missing: an agent that uses an Emberpath alias needs an Emberpath client key, '
  + 'or every model request is refused with 401. Create a client key in Emberpath (Client keys; Emberpath asks you to sign in again), '
  + 'preferably limited to the alias, and pass it as emberpath_client_key';
/** Why a key is never sent to an Emberpath only the Hive Registry named. */
export const EMBERPATH_KEY_NOT_EXPLICIT = 'Magnus sends an Emberpath client key only to an explicitly configured Emberpath; '
  + 'set MAGNUS_ARDENT_EMBERPATH_URL to the Emberpath the agents reach';

export type EmberpathKeyCheck = { checked: true } | { checked: false; reason: string };

const MAX_LIST_BYTES = 2 * 1024 * 1024;

/**
 * Ask Emberpath whether `key` may use `alias`, with the model listing a key can read (`GET <base>/models`,
 * the call Ardent's readiness makes). A definite refusal throws a 422: EMBERPATH_KEY_INVALID (401),
 * EMBERPATH_KEY_FORBIDDEN (403) or EMBERPATH_ALIAS_UNAVAILABLE (the alias is not in the key's list). When
 * Emberpath cannot be asked from this server (the agents may reach it at an address the server cannot),
 * the answer says so and New Agent goes on. The key is sent only in the Authorization header.
 */
export async function checkEmberpathClientKey(baseUrl: string, key: string, alias: string, fetcher: typeof fetch = fetch): Promise<EmberpathKeyCheck> {
  const url = new URL('models', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  let response: Response;
  try {
    response = await fetcher(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5000) });
  } catch {
    return { checked: false, reason: 'Emberpath could not be reached from the Magnus server to check the client key' };
  }
  if (response.status === 401) throw new HttpError(422, 'EMBERPATH_KEY_INVALID',
    'Emberpath refused the client key (401): it is unknown, disabled or expired. Create or rotate a client key in Emberpath and pass the new key as emberpath_client_key');
  if (response.status === 403) throw new HttpError(422, 'EMBERPATH_KEY_FORBIDDEN',
    'Emberpath accepted the client key but refused it the model list (403): the agent needs a key with the models:read and inference:write scopes');
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { checked: false, reason: `Emberpath answered HTTP ${response.status} when the client key was checked` };
  }
  const text = await response.text().catch(() => '');
  let ids: string[] | null = null;
  if (text.length <= MAX_LIST_BYTES) {
    try {
      const data = (JSON.parse(text) as { data?: unknown }).data;
      if (Array.isArray(data)) ids = data.map(item => (item as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === 'string');
    } catch { ids = null; }
  }
  if (ids === null) return { checked: false, reason: 'Emberpath did not answer with a model list when the client key was checked' };
  if (!ids.includes(alias)) throw new HttpError(422, 'EMBERPATH_ALIAS_UNAVAILABLE',
    `Emberpath does not offer ${alias} to this client key: check the alias, and the key's allowed models in Emberpath`);
  return { checked: true };
}

/** Keys waiting for their operation's config-save step, by operation ID. Memory only, never persisted. */
const pending = new Map<string, { key: string; until: number }>();
/** A failed operation keeps its key this long, so it can be resumed without the key. */
const PENDING_MS = 60 * 60_000;

export function holdEmberpathClientKey(operationId: string, key: string, now = Date.now()): void {
  for (const [id, entry] of pending) if (entry.until <= now) pending.delete(id);
  pending.set(operationId, { key, until: now + PENDING_MS });
}

/** The key held for an operation, or undefined when it was delivered, expired or held by another process. */
export function heldEmberpathClientKey(operationId: string, now = Date.now()): string | undefined {
  const entry = pending.get(operationId);
  if (entry && entry.until > now) return entry.key;
  pending.delete(operationId);
  return undefined;
}

export function releaseEmberpathClientKey(operationId: string): void {
  pending.delete(operationId);
}
