/** Per-domain path modules, merged into the document by `buildOpenApiSpec()`. */
import { mergePaths } from '../helpers.js';
import { paths as analytics } from './analytics.js';
import { paths as assistantChat } from './assistant-chat.js';
import { paths as assistantSettings } from './assistant-settings.js';
import { paths as fleet } from './fleet.js';
import { paths as machine } from './machine.js';
import { paths as operations } from './operations.js';

export const documentedPaths = mergePaths(analytics, assistantChat, assistantSettings, fleet, machine, operations);
