import {
  LayoutDashboard,
  Server,
  Terminal,
  Clock,
  FileText,
  ScrollText,
  Shield,
  Bot,
  Users,
  Siren,
  SlidersHorizontal,
  Webhook,
  Zap,
  Map,
  BookOpen,
  Compass,
  Globe2,
  HeartPulse,
  History,
  Database,
  GitCompareArrows,
  PackageCheck,
  ActivitySquare,
  ShieldCheck,
  ScanSearch,
  Code2,
  KeyRound,
  Radar,
  Gauge,
  type LucideIcon,
} from 'lucide-react';
import type { Tone } from './theme-colors';
import type { IntegrationFlags } from '../../runtime-integrations.mjs';

export type { IntegrationFlags };

/** Optional integrations a nav group can depend on. */
export type NavIntegration = 'securityConsole' | 'hermes';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Active only on an exact path match (group overview pages). */
  exact?: boolean;
  external?: boolean;
}

export interface NavGroup {
  id: string;
  label: string;
  tone: Extract<Tone, 'primary' | 'accent'>;
  /** Hidden unless this optional integration is configured. */
  integration?: NavIntegration;
  items: NavItem[];
}

/** Sidebar navigation; also the source of page names for the header. */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'fleet',
    label: 'Fleet',
    tone: 'primary',
    items: [
      { href: '/mission-control', label: 'Mission Control', icon: Compass },
      { href: '/', label: 'Overview', icon: LayoutDashboard, exact: true },
      { href: '/nodes', label: 'Nodes', icon: Server },
      { href: '/application-operations', label: 'Applications', icon: HeartPulse },
      { href: '/fleet-readiness', label: 'Readiness', icon: Gauge },
      { href: '/fleet-timeline', label: 'Timeline', icon: History },
      { href: '/fleet-map', label: 'Fleet Map', icon: Map },
      { href: '/commands', label: 'Commands', icon: Terminal },
      { href: '/anomalies', label: 'Anomalies', icon: Siren },
      { href: '/anomalies/remediation', label: 'Remediation', icon: Zap },
      { href: '/governor/operations', label: 'Operations', icon: SlidersHorizontal },
      { href: '/rollouts', label: 'Rollouts', icon: PackageCheck },
      { href: '/incidents', label: 'Incidents', icon: ActivitySquare },
      { href: '/cron', label: 'Cron Jobs', icon: Clock },
      { href: '/files', label: 'Files', icon: FileText },
      { href: '/logs', label: 'Logs', icon: ScrollText },
      { href: '/audit', label: 'Audit', icon: Shield },
      { href: '/webhooks', label: 'Webhooks', icon: Webhook },
      { href: '/retention', label: 'Retention', icon: Database },
      { href: '/api-docs', label: 'API Docs', icon: BookOpen },
    ],
  },
  {
    id: 'security',
    label: 'Security',
    tone: 'primary',
    integration: 'securityConsole',
    items: [
      { href: '/security-fusion', label: 'Fleet summary', icon: ScanSearch, exact: true },
    ],
  },
  {
    id: 'hermes',
    label: 'Hermes Agent',
    tone: 'accent',
    integration: 'hermes',
    items: [
      { href: '/orchestra', label: 'Overview', icon: Bot, exact: true },
      { href: '/orchestra/installations', label: 'Installations', icon: Server },
      { href: '/orchestra/profiles', label: 'Profiles', icon: Users },
      { href: '/hermes-drift', label: 'Drift Cockpit', icon: GitCompareArrows },
      { href: '/hermes-security', label: 'Proxy Security', icon: ShieldCheck },
      { href: '/orchestra/web-gateway', label: 'Web Gateway', icon: Globe2 },
    ],
  },
  {
    id: 'ardent',
    label: 'Magnus Ardent',
    tone: 'primary',
    items: [
      { href: '/ardent', label: 'Overview', icon: Radar, exact: true },
      { href: '/ardent/installations', label: 'Installations', icon: Server },
      { href: '/ardent/profiles', label: 'Profiles', icon: Users },
    ],
  },
  {
    id: 'codex',
    label: 'Codex Agent',
    tone: 'primary',
    items: [
      { href: '/codex', label: 'Overview', icon: Code2, exact: true },
      { href: '/codex/installations', label: 'Installations', icon: KeyRound },
    ],
  },
];

/** Integration state with every optional integration disabled. */
export const NO_INTEGRATIONS: IntegrationFlags = {
  securityConsoleUrl: null,
  hiveRouter: false,
  hiveLogin: false,
  hermes: false,
};

function integrationEnabled(integration: NavIntegration, flags: IntegrationFlags): boolean {
  if (integration === 'securityConsole') return flags.securityConsoleUrl !== null;
  return flags.hermes;
}

/**
 * Sidebar groups for the configured integrations. Groups tied to an
 * unconfigured integration are dropped; the security group gains an external
 * link to the configured console.
 */
export function visibleNavGroups(flags: IntegrationFlags, groups: NavGroup[] = NAV_GROUPS): NavGroup[] {
  return groups
    .filter((group) => !group.integration || integrationEnabled(group.integration, flags))
    .map((group) => group.id === 'security' && flags.securityConsoleUrl
      ? { ...group, items: [{ href: flags.securityConsoleUrl, label: 'Security console ↗', icon: ScanSearch, external: true }, ...group.items] }
      : group);
}

/** Header titles; more specific paths win. */
const PAGE_NAMES: Record<string, string> = {
  '/': 'Fleet Overview',
  '/mission-control': 'Mission Control',
  '/nodes': 'Nodes',
  '/application-operations': 'Application Operations',
  '/fleet-readiness': 'Fleet Readiness',
  '/fleet-timeline': 'Fleet Timeline',
  '/fleet-map': 'Fleet Map',
  '/commands': 'Commands',
  '/anomalies': 'Anomalies',
  '/anomalies/remediation': 'Auto-Remediation',
  '/governor/operations': 'Fleet Operations',
  '/rollouts': 'Guided Rollouts',
  '/incidents': 'Incident Workspace',
  '/cron': 'Cron Jobs',
  '/files': 'Files',
  '/logs': 'Logs',
  '/audit': 'Audit',
  '/webhooks': 'Webhooks',
  '/retention': 'Retention',
  '/api-docs': 'API Docs',
  '/library': 'Library',
  '/skills': 'Skills',
  '/roles': 'Roles',
  '/sync': 'Sync',
  '/notifications': 'Notification Preferences',
  '/security-fusion': 'Security',
  '/orchestra': 'Hermes Agent Fleet',
  '/orchestra/installations': 'Hermes Installations',
  '/orchestra/profiles': 'Hermes Profiles',
  '/orchestra/web-gateway': 'Web Gateway',
  '/hermes-drift': 'Hermes Drift Cockpit',
  '/hermes-security': 'Hermes Proxy Security',
  '/ardent': 'Magnus Ardent',
  '/ardent/installations': 'Ardent Installations',
  '/ardent/profiles': 'Ardent Profiles',
  '/codex': 'Codex Agent Fleet',
  '/codex/installations': 'Codex Installations',
};

function matches(pathname: string, href: string, exact = false): boolean {
  if (href === '/' || exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The single most specific nav item for a path, so only one indicator is active. */
export function activeNavHref(pathname: string): string | null {
  let best: string | null = null;
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (item.external) continue;
      if (matches(pathname, item.href, item.exact) && (best === null || item.href.length > best.length)) best = item.href;
    }
  }
  return best;
}

export interface Crumb {
  label: string;
  href?: string;
}

/** Page title plus breadcrumb trail (`fleet / nodes / host-01`). */
export function routeInfo(pathname: string): { title: string; group: string | null; crumbs: Crumb[] } {
  let base: string | null = null;
  for (const href of Object.keys(PAGE_NAMES)) {
    if (matches(pathname, href) && (base === null || href.length > base.length)) base = href;
  }
  const title = base ? PAGE_NAMES[base]! : 'Magnus';
  const navHref = activeNavHref(pathname);
  const group = navHref ? (NAV_GROUPS.find((g) => g.items.some((i) => i.href === navHref))?.label ?? null) : null;

  const crumbs: Crumb[] = [];
  if (group) crumbs.push({ label: group });
  crumbs.push({ label: title, href: base ?? undefined });
  if (base && pathname !== base) {
    const rest = pathname.slice(base === '/' ? 1 : base.length + 1).split('/').filter(Boolean);
    for (const segment of rest) {
      const decoded = decodeURIComponent(segment);
      crumbs.push({ label: decoded.length > 18 ? `${decoded.slice(0, 8)}…${decoded.slice(-6)}` : decoded });
    }
  }
  return { title, group, crumbs };
}
