/** Programmatic API of @hivemagnus/magnus (the `magnus` command is the supported interface). */
export { run, parseArgs, USAGE, ArgsError } from './main.js';
export { Project, findProjectDir, acquireLock, type ProjectState, type HistoryEntry } from './project.js';
export { upgrade, applyInstalled, missingEnv, UpgradeError, type UpgradeOptions } from './upgrade.js';
export { rollback, type RollbackOptions } from './rollback.js';
export { init, type InitOptions } from './init.js';
export { adopt, type AdoptOptions } from './adopt.js';
export { status, type StatusOptions } from './status.js';
export { systemIo, type Io } from './io.js';
export * from './release.js';
