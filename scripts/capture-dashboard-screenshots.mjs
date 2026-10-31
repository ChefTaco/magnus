#!/usr/bin/env node
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(new URL('../apps/dashboard/package.json', import.meta.url));
const { chromium } = require('playwright');

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'https://localhost:3000';
const outDir = resolve('output/playwright', `deploy-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(outDir, { recursive: true });

const pages = [
  ['mission-control', '/mission-control'],
  ['fleet-readiness', '/fleet-readiness'],
  ['nodes', '/nodes'],
  ['operations', '/governor/operations'],
  ['orchestra-installations', '/orchestra/installations'],
  ['api-docs', '/api-docs'],
  ['security-fusion-overview', '/security-fusion'],
  ['security-fusion-cases', '/security-fusion/cases'],
  ['security-fusion-events', '/security-fusion/events'],
  ['security-fusion-entities', '/security-fusion/entities'],
  ['security-fusion-sources', '/security-fusion/sources'],
  ['security-fusion-evidence', '/security-fusion/evidence'],
  ['security-fusion-policies', '/security-fusion/policies'],
];

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true, storageState: 'apps/dashboard/tests/.auth/user.json' });
const page = await context.newPage();

for (const [name, path] of pages) {
  await page.goto(`${baseURL}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
}

await page.setViewportSize({ width: 390, height: 844 });
for (const [name, path] of pages.filter(([candidate]) => candidate.startsWith('security-fusion'))) {
  await page.goto(`${baseURL}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${outDir}/${name}-mobile.png`, fullPage: true });
}

await browser.close();
console.log(outDir);
