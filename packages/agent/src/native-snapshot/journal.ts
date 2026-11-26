/**
 * Ardent's journal policy and read-only inspector. Ardent owns its schema, so it owns which tables
 * can hold runnable or uncertain work; Magnus keeps no table list of its own.
 *
 * The module comes from the pinned @hivemagnus/ardent, a development dependency. `npm run build`
 * (build-journal-module.mjs) replaces this re-export in dist with Ardent's own module, reading the
 * private snapshot copy through `journal-sqlite.ts`, so the published agent does not depend on the
 * Ardent runtime.
 */
export { inspectJournalFile, JOURNAL_POLICY_VERSION, type JournalStatus } from '@hivemagnus/ardent/journal';
