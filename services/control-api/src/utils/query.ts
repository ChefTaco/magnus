/**
 * Numeric query parameters. Every list route used to parse these by hand, and most let `abc`,
 * `0` or a negative number through to the database as NaN or a negative offset.
 */

interface QueryContext {
  req: { query(name: string): string | undefined };
}

export interface IntQueryOptions {
  fallback: number;
  min: number;
  max: number;
}

/**
 * An integer query parameter. A missing or non-numeric value is the fallback; a fraction is
 * truncated; the result is clamped to [min, max].
 */
export function intQuery(c: QueryContext, name: string, options: IntQueryOptions): number {
  const raw = c.req.query(name);
  const parsed = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
  const value = Number.isFinite(parsed) ? Math.trunc(parsed) : options.fallback;
  return Math.min(Math.max(value, options.min), options.max);
}

export interface PaginationOptions {
  /** Page size when the caller names none. */
  pageSize: number;
  maxPageSize: number;
  /** The page-size parameter, for routes that call it `limit`. */
  pageSizeParam?: string;
}

/** `page` (from 1) and the page size, always usable as a database offset and limit. */
export function pagination(c: QueryContext, options: PaginationOptions): { page: number; pageSize: number } {
  return {
    page: intQuery(c, 'page', { fallback: 1, min: 1, max: Number.MAX_SAFE_INTEGER }),
    pageSize: intQuery(c, options.pageSizeParam ?? 'pageSize', { fallback: options.pageSize, min: 1, max: options.maxPageSize }),
  };
}
