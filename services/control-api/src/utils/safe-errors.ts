/**
 * Turns database and transport failures into text that is safe to send to a client.
 *
 * Prisma messages quote the failing call, its arguments, constraint names and the
 * database address. Socket errors quote the peer's address, and `fetch` reports
 * only "fetch failed". None of that belongs in a response, so the text here comes
 * from fixed tables and never from the error's own message.
 */

interface DatabaseFailure {
  status: 400 | 404 | 409 | 500 | 503;
  code: string;
  message: string;
}

const INVALID: DatabaseFailure = { status: 400, code: 'VALIDATION_ERROR', message: 'The request contains an invalid value.' };
const NOT_FOUND: DatabaseFailure = { status: 404, code: 'NOT_FOUND', message: 'The requested record was not found.' };
const IN_USE: DatabaseFailure = { status: 409, code: 'CONFLICT', message: 'The change refers to a record that does not exist or is still in use.' };
const UNAVAILABLE: DatabaseFailure = { status: 503, code: 'DATABASE_UNAVAILABLE', message: 'The database is temporarily unavailable. Try again shortly.' };
const UNEXPECTED: DatabaseFailure = { status: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' };

const DATABASE_FAILURES: Readonly<Record<string, DatabaseFailure>> = {
  P2000: INVALID, P2005: INVALID, P2006: INVALID, P2007: INVALID, P2011: INVALID, P2012: INVALID, P2019: INVALID, P2020: INVALID, P2023: INVALID,
  P2001: NOT_FOUND, P2015: NOT_FOUND, P2018: NOT_FOUND, P2025: NOT_FOUND,
  P2003: IN_USE, P2014: IN_USE,
  P2024: UNAVAILABLE, P2034: UNAVAILABLE, P2037: UNAVAILABLE,
};

const PRISMA_ERROR_NAME = /^PrismaClient(?:KnownRequest|UnknownRequest|Initialization|Validation|RustPanic)Error$|^DriverAdapterError$/u;
/** Prisma text that reached a message through a wrapper, such as a route catching "not found". */
const PRISMA_TEXT = /Invalid `[^`]+` invocation|PrismaClient|Unique constraint failed|Foreign key constraint|Can't reach database server|required but not found/iu;

function errorProperty(error: unknown, key: string): unknown {
  return error && typeof error === 'object' && key in error ? (error as Record<string, unknown>)[key] : undefined;
}

function isPrismaError(error: unknown): boolean {
  const code = errorProperty(error, 'code');
  return (typeof code === 'string' && /^P\d{4}$/u.test(code))
    || (typeof errorProperty(error, 'name') === 'string' && PRISMA_ERROR_NAME.test(errorProperty(error, 'name') as string));
}

const words = (name: string): string => name.replace(/(?<=[a-z])(?=[A-Z])/gu, ' ').toLowerCase();

/** `HermesCredentialPool` becomes `hermes credential pool`. */
function modelLabel(error: unknown): string | null {
  const name = errorProperty(errorProperty(error, 'meta'), 'modelName');
  return typeof name === 'string' && /^[A-Za-z]+$/u.test(name)
    ? words(name)
    : null;
}

/**
 * The columns of a violated unique constraint. The PostgreSQL adapter reports only the
 * index, named `<table>_<columns>_key`. Other paths report the columns themselves.
 */
function constraintFields(error: unknown): string[] {
  const meta = errorProperty(error, 'meta');
  const cause = errorProperty(errorProperty(meta, 'driverAdapterError'), 'cause');
  const constraint = errorProperty(cause, 'constraint');
  const listed = errorProperty(constraint, 'fields') ?? errorProperty(meta, 'target');
  if (Array.isArray(listed)) return listed.filter((field): field is string => typeof field === 'string' && /^[A-Za-z_]+$/u.test(field));
  const index = errorProperty(constraint, 'index');
  const table = errorProperty(cause, 'table');
  if (typeof index !== 'string' || typeof table !== 'string' || !index.startsWith(`${table}_`) || !index.endsWith('_key')) return [];
  const columns = index.slice(table.length + 1, -'_key'.length);
  return /^[A-Za-z]+(?:_[A-Za-z]+)*$/u.test(columns) ? columns.split('_') : [];
}

function duplicateMessage(error: unknown): string {
  const label = modelLabel(error);
  const fields = constraintFields(error).map(words);
  const subject = label ? `A ${label}` : 'A record';
  return fields.length > 0 ? `${subject} with this ${fields.join(' and ')} already exists.` : `${subject} with the same unique value already exists.`;
}

/** The client's view of a database error, or null for any other error. */
export function databaseFailure(error: unknown): DatabaseFailure | null {
  if (!isPrismaError(error)) return null;
  const name = errorProperty(error, 'name');
  if (name === 'PrismaClientValidationError') return INVALID;
  if (name === 'PrismaClientInitializationError') return UNAVAILABLE;
  const code = errorProperty(error, 'code');
  if (typeof code !== 'string') return UNEXPECTED;
  if (code === 'P2002') return { status: 409, code: 'CONFLICT', message: duplicateMessage(error) };
  if (code.startsWith('P1')) return UNAVAILABLE;
  return DATABASE_FAILURES[code] ?? UNEXPECTED;
}

export function containsDatabaseText(message: string): boolean {
  return PRISMA_TEXT.test(message);
}

/** An error's own message for a client, unless it is, or quotes, a database error. */
export function clientErrorMessage(error: unknown, fallback: string): string {
  const failure = databaseFailure(error);
  if (failure) return failure.message;
  const message = error instanceof Error ? error.message : '';
  return message && !containsDatabaseText(message) ? message : fallback;
}

const TLS_VERIFICATION = 'its TLS certificate could not be verified';
const TRANSPORT_FAILURES: Readonly<Record<string, string>> = {
  ECONNREFUSED: 'the connection was refused',
  ECONNRESET: 'the connection was closed unexpectedly',
  EPIPE: 'the connection was closed unexpectedly',
  UND_ERR_SOCKET: 'the connection was closed unexpectedly',
  ETIMEDOUT: 'the connection timed out',
  UND_ERR_CONNECT_TIMEOUT: 'the connection timed out',
  UND_ERR_HEADERS_TIMEOUT: 'the response timed out',
  ENOTFOUND: 'the address could not be resolved',
  EAI_AGAIN: 'the address could not be resolved',
  EHOSTUNREACH: 'there is no network route to it',
  ENETUNREACH: 'there is no network route to it',
  EPROTO: 'the TLS handshake failed',
  ERR_SSL_WRONG_VERSION_NUMBER: 'the TLS handshake failed',
  CERT_HAS_EXPIRED: 'its TLS certificate has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: TLS_VERIFICATION,
  SELF_SIGNED_CERT_IN_CHAIN: TLS_VERIFICATION,
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: TLS_VERIFICATION,
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: TLS_VERIFICATION,
  ERR_TLS_CERT_ALTNAME_INVALID: TLS_VERIFICATION,
  EACCES: 'permission was denied',
  ENOENT: 'the path does not exist',
};

/** Why a connection failed, in words that name no host, port, path or URL. */
export function describeTransportFailure(error: unknown): string {
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const name = errorProperty(current, 'name');
    if (name === 'TimeoutError' || name === 'AbortError') return 'the request timed out';
    const code = errorProperty(current, 'code');
    if (typeof code === 'string' && TRANSPORT_FAILURES[code]) return `${TRANSPORT_FAILURES[code]} (${code})`;
    current = errorProperty(current, 'cause');
  }
  return 'the request failed';
}
