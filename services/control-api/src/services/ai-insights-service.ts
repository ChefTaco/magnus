/**
 * ai-insights-service.ts — AI-powered fleet insights generation.
 *
 * Generates structured insights from fleet data using the AI model.
 * Results are cached for 10 minutes to avoid excessive LLM calls.
 */

import { getDb } from '../db/index.js';
import { chat } from './ai-assistant-service.js';
import { nanoid } from 'nanoid';

export interface AiInsight {
  title: string;
  body: string;
  severity: 'critical' | 'warning' | 'info' | 'success';
  category: string;
  nodeId?: string;
}

export interface InsightsResponse {
  insights: AiInsight[];
  generatedAt: string;
  conversationId?: string;
}

export interface PinnedAiInsight extends AiInsight {
  id: string;
  pinnedAt: string;
  generatedAt?: string;
}

// ── Cache ──
let cachedInsights: InsightsResponse | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Generate AI-powered fleet insights.
 * Uses a dedicated heartbeat-style analysis conversation.
 * Results are cached for 10 minutes.
 */
export async function generateInsights(force = false): Promise<InsightsResponse> {
  const now = Date.now();

  // Return cached result if still fresh
  if (!force && cachedInsights && (now - cacheTime) < CACHE_TTL_MS) {
    return cachedInsights;
  }

  const db = getDb();

  const latestStructuredHeartbeat = await db.aiMessage.findFirst({
    where: {
      conversation: { type: 'heartbeat' },
      structuredAnalysis: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    select: { structuredAnalysis: true, createdAt: true, conversationId: true },
  });

  if (!force && latestStructuredHeartbeat?.structuredAnalysis) {
    try {
      const structured = JSON.parse(latestStructuredHeartbeat.structuredAnalysis) as { insights?: AiInsight[]; generatedAt?: string };
      if (Array.isArray(structured.insights) && structured.insights.length > 0) {
        const response: InsightsResponse = {
          insights: structured.insights.slice(0, 5).map((insight) => ({
            title: String(insight.title ?? 'Insight').slice(0, 80),
            body: String(insight.body ?? '').slice(0, 500),
            severity: (['critical', 'warning', 'info', 'success'].includes(insight.severity) ? insight.severity : 'info') as AiInsight['severity'],
            category: String(insight.category ?? 'health'),
            nodeId: insight.nodeId ? String(insight.nodeId) : undefined,
          })),
          generatedAt: structured.generatedAt ?? latestStructuredHeartbeat.createdAt.toISOString(),
          conversationId: latestStructuredHeartbeat.conversationId,
        };
        cachedInsights = response;
        cacheTime = now;
        return response;
      }
    } catch {
      // fall back to active generation below
    }
  }

  // Gather fleet context
  const [nodeCount, onlineCount, anomalyCount, recentCommands] = await Promise.all([
    db.node.count({ where: { metadata: { not: '{"sentinel":true}' } } }),
    db.node.count({ where: { status: 'ONLINE', metadata: { not: '{"sentinel":true}' } } }),
    db.anomalyEvent.count({ where: { resolved: false } }),
    db.remoteCommand.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { command: true, status: true, nodeId: true, createdAt: true },
    }),
  ]);

  // Get recent anomalies for context
  const recentAnomalies = await db.anomalyEvent.findMany({
    where: { resolved: false },
    orderBy: { createdAt: 'desc' },
    take: 15,
    select: { nodeId: true, metric: true, value: true, severity: true, zScore: true, createdAt: true },
  });

  // Get latest health snapshots
  const nodes = await db.node.findMany({
    where: { metadata: { not: '{"sentinel":true}' } },
    select: { id: true, name: true, status: true },
  });

  const healthSnapshots = await Promise.all(
    nodes.slice(0, 10).map(async (node) => {
      const snapshot = await db.healthSnapshot.findFirst({
        where: { nodeId: node.id },
        orderBy: { timestamp: 'desc' },
        select: { cpuUsagePercent: true, memoryPercent: true, disks: true, timestamp: true },
      });
      return { nodeName: node.name, status: node.status, health: snapshot };
    }),
  );

  const insightPrompt = `You are analyzing fleet health data. Generate a JSON array of insights.

FLEET STATUS:
- Total nodes: ${nodeCount}, Online: ${onlineCount}, Offline: ${nodeCount - onlineCount}
- Unresolved anomalies: ${anomalyCount}

RECENT ANOMALIES:
${recentAnomalies.map(a => `- [${a.severity}] ${a.metric}=${a.value.toFixed(1)} (z=${a.zScore.toFixed(1)}) on ${a.nodeId}`).join('\n') || 'None'}

NODE HEALTH:
${healthSnapshots.map(h => {
    if (!h.health) return `- ${h.nodeName}: ${h.status} (no health data)`;
    return `- ${h.nodeName}: ${h.status} | CPU=${h.health.cpuUsagePercent.toFixed(0)}% MEM=${h.health.memoryPercent.toFixed(0)}%`;
  }).join('\n')}

RECENT COMMANDS:
${recentCommands.map(c => `- ${c.command.slice(0, 60)} → ${c.status}`).join('\n') || 'None'}

Respond ONLY with a valid JSON array of insight objects. Each object must have:
- "title": short headline (max 80 chars)
- "body": explanation (1-2 sentences)
- "severity": "critical" | "warning" | "info" | "success"
- "category": "health" | "security" | "performance" | "availability" | "trend"
- "nodeId": optional node ID if specific to one node

Generate 3-5 most important insights. No markdown, no explanation, ONLY the JSON array.`;

  try {
    const result = await chat({
      message: insightPrompt,
      type: 'analysis',
      createdBy: 'system',
    });

    // Parse the JSON response
    let insights: AiInsight[] = [];
    try {
      // Try to extract JSON array from the response
      const jsonMatch = result.content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        insights = JSON.parse(jsonMatch[0]) as AiInsight[];
      }
    } catch {
      // If parsing fails, create a single insight from the raw response
      insights = [{
        title: 'Fleet Analysis',
        body: result.content.slice(0, 200),
        severity: 'info',
        category: 'health',
      }];
    }

    // Validate and sanitize insights
    insights = insights.slice(0, 5).map(i => ({
      title: String(i.title ?? 'Insight').slice(0, 80),
      body: String(i.body ?? '').slice(0, 500),
      severity: (['critical', 'warning', 'info', 'success'].includes(i.severity) ? i.severity : 'info') as AiInsight['severity'],
      category: String(i.category ?? 'health'),
      nodeId: i.nodeId ? String(i.nodeId) : undefined,
    }));

    const response: InsightsResponse = {
      insights,
      generatedAt: new Date().toISOString(),
      conversationId: result.conversationId,
    };

    // Cache the result
    cachedInsights = response;
    cacheTime = now;

    return response;
  } catch (err) {
    console.error('[AI Insights] Generation failed:', err instanceof Error ? err.message : err);

    // Return a fallback insight
    const fallback: InsightsResponse = {
      insights: [{
        title: 'Insights Unavailable',
        body: 'Unable to generate AI insights at this time. The AI service may be offline.',
        severity: 'warning',
        category: 'availability',
      }],
      generatedAt: new Date().toISOString(),
    };

    return fallback;
  }
}

/**
 * Clear the insights cache (e.g., after significant fleet changes).
 */
export function clearInsightsCache(): void {
  cachedInsights = null;
  cacheTime = 0;
}

export async function listPinnedInsights(): Promise<PinnedAiInsight[]> {
  const db = getDb();
  const records = await db.aiMemory.findMany({
    where: { category: 'pinned_insight' },
    orderBy: { updatedAt: 'desc' },
  });

  return records.flatMap((record) => {
    try {
      return [JSON.parse(record.content) as PinnedAiInsight];
    } catch {
      return [];
    }
  });
}

export async function pinInsight(insight: AiInsight & { generatedAt?: string }): Promise<PinnedAiInsight> {
  const db = getDb();
  const pinned: PinnedAiInsight = {
    id: nanoid(),
    pinnedAt: new Date().toISOString(),
    generatedAt: insight.generatedAt,
    ...insight,
  };

  await db.aiMemory.create({
    data: {
      id: nanoid(),
      key: `pinned_insight:${pinned.id}`,
      category: 'pinned_insight',
      content: JSON.stringify(pinned),
      source: 'user',
      relevance: 0.0,
    },
  });

  return pinned;
}

export async function unpinInsight(id: string): Promise<void> {
  const db = getDb();
  await db.aiMemory.deleteMany({ where: { key: `pinned_insight:${id}` } });
}
