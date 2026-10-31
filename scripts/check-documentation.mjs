#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { dashboardEnvironmentReferenceRows } from '../apps/dashboard/runtime-environment.mjs';

const root = resolve(import.meta.dirname, '..');
const failures = [];

function readJson(path) {
  if (!existsSync(path)) {
    failures.push(`missing built route manifest: ${relative(root, path)} (run npm run dashboard:build first)`);
    return {};
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function routePatternMatches(pattern, candidate) {
  const patternParts = pattern.split('/').filter(Boolean);
  const candidateParts = candidate.split('/').filter(Boolean);
  let index = 0;
  for (const part of patternParts) {
    if (part.startsWith('[[...')) return true;
    if (part.startsWith('[...') || part.startsWith(':') && part.endsWith('*')) return candidateParts.length > index;
    if (candidateParts[index] == null) return false;
    if (!(part.startsWith('[') && part.endsWith(']')) && part !== candidateParts[index]) return false;
    index += 1;
  }
  return index === candidateParts.length;
}

function normalizeDocumentedRoute(value) {
  return value
    .replace(/[.,;:]$/, '')
    .replace(/\/\*$/, '')
    .replace(/\/$/, '') || '/';
}

function checkDashboardRoutes() {
  const appManifest = readJson(resolve(root, 'apps/dashboard/.next/app-path-routes-manifest.json'));
  const routesManifest = readJson(resolve(root, 'apps/dashboard/.next/routes-manifest.json'));
  const builtRoutes = new Set(Object.values(appManifest).filter((route) => !String(route).startsWith('/_')));
  const matchesBuiltRoute = (route) => [...builtRoutes].some((pattern) => routePatternMatches(pattern, route));
  const configuredSources = [
    ...(routesManifest.redirects ?? []).filter((route) => !route.internal).map((route) => route.source),
    ...Object.values(routesManifest.rewrites ?? {}).flat().map((route) => route.source),
  ];
  const matchesDashboardSurface = (route) => matchesBuiltRoute(route)
    || configuredSources.some((pattern) => routePatternMatches(pattern, route));
  const nonDashboardPrefixes = [
    '/api/v1',
    '/api/iam',
    '/metrics',
    '/opt/',
    '/usr/local/',
    '/var/',
  ];

  const documentation = [
    'README.md',
    'docs/APP_ARCHITECTURE.md',
    'docs/APP_ARCHITECTURE_HERMES.md',
    'docs/APP_ARCHITECTURE_CODEX.md',
    'docs/OBSERVABILITY.md',
    'apps/dashboard/README.md',
    'apps/dashboard/AGENTS.md',
  ];

  let references = 0;
  for (const file of documentation) {
    const lines = readFileSync(resolve(root, file), 'utf8').split('\n');
    let retiredDepth = null;
    let retiredParagraph = false;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (line.trim() === '') retiredParagraph = false;
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) {
        const depth = heading[1].length;
        if (retiredDepth != null && depth <= retiredDepth) retiredDepth = null;
        if (/retired|removed/i.test(heading[2])) retiredDepth = depth;
      }
      if (retiredDepth != null) continue;
      if (/retired|removed|do not reintroduce|no longer/i.test(line)) retiredParagraph = true;
      if (retiredParagraph) continue;

      for (const match of line.matchAll(/`(\/[^`\s]*)`/g)) {
        const route = normalizeDocumentedRoute(match[1]);
        if (route.startsWith('/etc/') || route.includes('<')
          || nonDashboardPrefixes.some((prefix) => route === prefix || route.startsWith(prefix))) continue;
        references += 1;
        if (!matchesDashboardSurface(route)) failures.push(`${file}:${lineIndex + 1} documents dashboard route ${route}, absent from the built route manifest`);
      }
    }
  }

  for (const redirect of routesManifest.redirects ?? []) {
    if (redirect.internal) continue;
    if (!matchesBuiltRoute(normalizeDocumentedRoute(redirect.destination))) {
      failures.push(`built redirect ${redirect.source} targets missing dashboard route ${redirect.destination}`);
    }
  }
  for (const rewriteGroup of Object.values(routesManifest.rewrites ?? {})) {
    for (const rewrite of rewriteGroup) {
      const destination = normalizeDocumentedRoute(rewrite.destination.replace(/:\w+\*?/g, 'probe'));
      if (!matchesBuiltRoute(destination)) failures.push(`built rewrite ${rewrite.source} targets missing dashboard route ${rewrite.destination}`);
    }
  }

  return { routes: builtRoutes.size, references };
}

function renderEnvironmentTable() {
  const rows = dashboardEnvironmentReferenceRows();
  const rendered = [
    '<!-- dashboard-environment:start -->',
    '<!-- Generated from runtime-environment.mjs by scripts/check-documentation.mjs. -->',
    '| Variable | Requirement | Default | Purpose |',
    '| --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    const requirement = row.requirement ?? (row.required ? 'Required' : 'Optional');
    const defaultValue = row.sensitive ? 'None' : row.default == null ? 'None' : `\`${String(row.default)}\``;
    rendered.push(`| \`${row.name}\` | ${requirement} | ${defaultValue} | ${row.purpose} |`);
  }
  rendered.push('<!-- dashboard-environment:end -->');
  return rendered.join('\n');
}

function checkEnvironmentReference() {
  const readmePath = resolve(root, 'apps/dashboard/README.md');
  const content = readFileSync(readmePath, 'utf8');
  const expected = renderEnvironmentTable();
  const match = /<!-- dashboard-environment:start -->[\s\S]*?<!-- dashboard-environment:end -->/.exec(content);
  if (!match) failures.push('apps/dashboard/README.md is missing the generated dashboard environment reference');
  else if (match[0] !== expected) failures.push('apps/dashboard/README.md environment table differs from the runtime configuration schema; run npm run docs:generate');
  const exampleLines = readFileSync(resolve(root, 'apps/dashboard/.env.example'), 'utf8').split('\n');
  for (const row of dashboardEnvironmentReferenceRows()) {
    const declared = exampleLines.some((line) => new RegExp(`^#?\\s*${row.name}=`).test(line));
    if (!declared) failures.push(`apps/dashboard/.env.example is missing schema variable ${row.name}`);
  }
  return dashboardEnvironmentReferenceRows().length;
}

const routeCounts = checkDashboardRoutes();
const environmentVariables = checkEnvironmentReference();

if (failures.length > 0) {
  console.error(`Documentation contract check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Documentation contract check passed (${routeCounts.references} documented dashboard route references, ${routeCounts.routes} built routes, ${environmentVariables} environment variables).`);
