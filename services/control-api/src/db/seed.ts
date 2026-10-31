/**
 * Base data every installation needs: the internal system actor (never a
 * login-capable administrator), the sentinel nodes that internal log sources
 * reference, and the starter library. Safe to run repeatedly; `magnus-server
 * migrate` runs it after applying migrations.
 */
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { PrismaClient } from './generated/prisma/client.js';

/** Argon2id config per project security conventions. */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
} as const;

async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/** Idempotently create the system actor, sentinel nodes and library content. */
export async function seedDatabase(prisma: PrismaClient, log: (line: string) => void = console.log): Promise<void> {
  log('🌱 Seeding database…');

  // ── System user (used by API-secret / agent auth) ──
  let systemUser = await prisma.user.findUnique({ where: { id: 'system' } });
  if (!systemUser) {
    systemUser = await prisma.user.findUnique({ where: { email: 'system@magnus.local' } });
  }
  if (!systemUser) {
    systemUser = await prisma.user.create({
      data: {
        id: 'system',
        email: 'system@magnus.local',
        name: 'System',
        password: await hashPassword(randomBytes(32).toString('hex')),
        role: 'ADMIN',
        active: true,
      },
    });
  }
  log(`  ✓ User: ${systemUser.email} (${systemUser.role}) [system actor]`);

  // ── Sentinel nodes for internal log sources ──
  // These virtual nodes allow Control API and Dashboard logs to use the
  // same logEntry table with referential integrity intact.
  const sentinelNodes = [
    {
      id: '__control-api__',
      name: '__control-api__',
      hostname: '__control-api__',
      ipAddress: '127.0.0.1',
      port: 4000,
      os: 'internal',
      arch: 'internal',
      token: `sentinel-control-api-${randomBytes(16).toString('hex')}`,
    },
    {
      id: '__dashboard__',
      name: '__dashboard__',
      hostname: '__dashboard__',
      ipAddress: '127.0.0.1',
      port: 3000,
      os: 'internal',
      arch: 'internal',
      token: `sentinel-dashboard-${randomBytes(16).toString('hex')}`,
    },
  ];

  for (const sentinel of sentinelNodes) {
    const existing = await prisma.node.findUnique({ where: { id: sentinel.id } });
    if (!existing) {
      await prisma.node.create({
        data: {
          id: sentinel.id,
          name: sentinel.name,
          hostname: sentinel.hostname,
          ipAddress: sentinel.ipAddress,
          port: sentinel.port,
          status: 'ONLINE',
          os: sentinel.os,
          arch: sentinel.arch,
          token: sentinel.token,
          metadata: '{"sentinel":true}',
        },
      });
      log(`  ✓ Sentinel Node: ${sentinel.name}`);
    } else {
      log(`  ✓ Sentinel Node: ${sentinel.name} (already exists)`);
    }
  }

  // ── Library: Categories ──
  const personalityCat = await prisma.libraryCategory.upsert({
    where: { name: 'Personality' },
    update: {},
    create: {
      name: 'Personality',
      description: 'Core identity and personality files for Orchestra agents',
      color: '#6366f1',
      sortOrder: 0,
    },
  });
  log(`  ✓ Library Category: ${personalityCat.name}`);

  const knowledgeCat = await prisma.libraryCategory.upsert({
    where: { name: 'Knowledge' },
    update: {},
    create: {
      name: 'Knowledge',
      description: 'Knowledge bases and reference material',
      color: '#3b82f6',
      sortOrder: 1,
    },
  });
  log(`  ✓ Library Category: ${knowledgeCat.name}`);

  const templatesCat = await prisma.libraryCategory.upsert({
    where: { name: 'Templates' },
    update: {},
    create: {
      name: 'Templates',
      description: 'Reusable file templates and boilerplates',
      color: '#22c55e',
      sortOrder: 2,
    },
  });
  log(`  ✓ Library Category: ${templatesCat.name}`);

  const configCat = await prisma.libraryCategory.upsert({
    where: { name: 'Config' },
    update: {},
    create: {
      name: 'Config',
      description: 'Configuration files and system settings',
      color: '#f59e0b',
      sortOrder: 3,
    },
  });
  log(`  ✓ Library Category: ${configCat.name}`);

  // ── Library: Standard Agent Files ──
  const agentFiles = [
    {
      name: 'SOUL',
      fileName: 'SOUL.md',
      mimeType: 'text/markdown',
      categoryId: personalityCat.id,
      tags: '["personality","core","identity"]',
      content: `# SOUL.md — Agent Personality Definition

## Identity
You are a Magnus fleet node agent — a helpful, precise, and security-conscious AI assistant that manages Linux systems.

## Core Traits
- **Reliable**: Always follow through on tasks and provide accurate status updates
- **Security-First**: Never expose secrets, tokens, or sensitive data in logs or responses
- **Transparent**: Explain what you're doing and why before executing commands
- **Cautious**: Warn about destructive operations and request confirmation
- **Efficient**: Minimize resource usage and prefer lightweight solutions

## Communication Style
- Clear, concise responses without unnecessary verbosity
- Technical accuracy with appropriate detail level
- Use markdown formatting for structured output
- Include relevant context without overwhelming the operator

## Boundaries
- Never modify system files without explicit authorization
- Always validate inputs before executing commands
- Respect resource limits and timeout constraints
- Escalate unknown situations rather than guessing
`,
    },
    {
      name: 'MEMORY',
      fileName: 'MEMORY.md',
      mimeType: 'text/markdown',
      categoryId: personalityCat.id,
      tags: '["memory","context","state"]',
      content: `# MEMORY.md — Agent Memory & Context

## Operational Context
- Managed by Magnus Fleet Management Platform
- Reports to control-api via heartbeat every 30 seconds
- Executes commands dispatched through BullMQ queue

## Known Facts
- Operating system details are collected via HealthCollector
- Disk, CPU, memory, and network stats are monitored continuously
- Cron jobs are managed with MAGNUS: markers in system crontab

## Session History
<!-- This file is updated as the agent learns and remembers -->
- Initial deployment: Agent installed and registered with control plane
- Health monitoring: Active and reporting nominal metrics

## Important Notes
- File sync operations require checksum verification
- Skill installations go to /opt/magnus/skills/
- Self-updates require systemd restart scheduling
`,
    },
    {
      name: 'KNOWLEDGE',
      fileName: 'KNOWLEDGE.md',
      mimeType: 'text/markdown',
      categoryId: knowledgeCat.id,
      tags: '["knowledge","reference","docs"]',
      content: `# KNOWLEDGE.md — Agent Knowledge Base

## System Administration
- Package management: apt/dnf depending on distro
- Service management: systemctl for systemd services
- Log management: journalctl for system logs
- Network: ip, ss, netstat for network diagnostics
- Disk: df, du, lsblk for storage management

## Magnus Platform
- Control API runs on port 4000
- Node Manager agents run on port 4100
- Dashboard available on port 3000
- Redis on port 6379 for queues and caching

## Security Practices
- Tokens are JWT-signed with HS256
- Node authentication via x-node-token header
- All state changes are audit-logged
- Secrets are never logged or returned in API responses

## Common Tasks
- Health check: GET /health
- Command execution: POST /execute with timeout
- File sync: POST /files/update with checksum
- Cron management: POST /cron with MAGNUS markers
`,
    },
    {
      name: 'SKILLS',
      fileName: 'SKILLS.md',
      mimeType: 'text/markdown',
      categoryId: knowledgeCat.id,
      tags: '["skills","capabilities","reference"]',
      content: `# SKILLS.md — Agent Capabilities

## Core Skills
1. **System Monitoring** — Collect and report CPU, memory, disk, network metrics
2. **Command Execution** — Run shell commands with timeout and output capture
3. **Cron Management** — Create, update, delete cron jobs with tracking markers
4. **File Sync** — Read and write files with checksum verification
5. **Skill Installation** — Download, verify, and install skill bundles
6. **Self-Update** — Download new agent version and schedule restart

## Monitoring Capabilities
- CPU usage percentage and load averages
- Memory and swap utilization
- Disk usage per mount point
- Network interface statistics
- Service status via systemctl
- Cockpit availability detection

## Execution Constraints
- Maximum command timeout: configurable (default 300s)
- Output size limit: 1MB per command
- Concurrent executions: limited by BullMQ concurrency
- Risk assessment: low/medium/high classification
`,
    },
    {
      name: 'RULES',
      fileName: 'RULES.md',
      mimeType: 'text/markdown',
      categoryId: personalityCat.id,
      tags: '["rules","constraints","safety"]',
      content: `# RULES.md — Agent Operating Rules

## Critical Rules (Never Violate)
1. **Never expose secrets** — tokens, passwords, API keys must never appear in logs or responses
2. **Never execute without authorization** — all commands must come through the authenticated control plane
3. **Always verify checksums** — file sync and skill installations must verify integrity
4. **Respect timeouts** — kill processes that exceed their timeout limit
5. **Audit everything** — all state-changing operations must be logged

## Operational Rules
1. Report health status every 30 seconds via heartbeat
2. Update agent status when starting/stopping operations
3. Use idempotency keys to prevent duplicate command execution
4. Preserve existing cron jobs that don't have MAGNUS markers
5. Back up files before overwriting when previousChecksum exists

## Safety Rules
1. Warn before executing destructive commands (rm -rf, format, etc.)
2. Validate file paths to prevent directory traversal attacks
3. Sanitize command output to strip potential secrets
4. Limit resource consumption (CPU, memory, disk I/O)
5. Gracefully handle network failures with retry logic
`,
    },
    {
      name: 'GOALS',
      fileName: 'GOALS.md',
      mimeType: 'text/markdown',
      categoryId: personalityCat.id,
      tags: '["goals","objectives","mission"]',
      content: `# GOALS.md — Agent Objectives

## Primary Mission
Maintain the health, security, and operational readiness of the assigned Linux system as part of the Magnus fleet.

## Ongoing Goals
1. **Uptime** — Maximize system availability and minimize unplanned downtime
2. **Security** — Keep the system patched, monitored, and free of vulnerabilities
3. **Performance** — Optimize resource utilization and identify bottlenecks
4. **Compliance** — Ensure all operations follow the rules defined in RULES.md
5. **Reporting** — Provide accurate, timely health and status information

## Success Metrics
- Heartbeat consistency: >99.9% on-time delivery
- Command execution: <5s average response time
- Health monitoring: No gaps in metric collection
- File sync: 100% checksum verification pass rate
- Skill installations: Zero failed deployments

## Growth Objectives
- Learn from operational patterns to improve efficiency
- Adapt to new skill bundles and capabilities
- Provide proactive alerts and recommendations
`,
    },
  ];

  for (const file of agentFiles) {
    const existing = await prisma.libraryFile.findFirst({
      where: { fileName: file.fileName },
    });

    if (!existing) {
      await prisma.libraryFile.create({
        data: {
          name: file.name,
          fileName: file.fileName,
          mimeType: file.mimeType,
          content: file.content,
          sizeBytes: Buffer.byteLength(file.content, 'utf-8'),
          categoryId: file.categoryId,
          tags: file.tags,
          createdBy: systemUser.id,
        },
      });
      log(`  ✓ Library File: ${file.fileName}`);
    } else {
      log(`  ✓ Library File: ${file.fileName} (already exists)`);
    }
  }

  // ── Skills are now file-based (see skills/ directory) — no DB seeding needed ──

  log('✅ Seed complete.');
}
