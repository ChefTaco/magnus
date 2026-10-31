/**
 * ai-export-service.ts — Conversation export in multiple formats.
 *
 * Supports exporting AI conversations as Markdown, JSON, or CSV.
 */

import { getDb } from '../db/index.js';

export type ExportFormat = 'markdown' | 'json' | 'csv';

/**
 * Export a conversation in the specified format.
 */
export async function exportConversation(
  conversationId: string,
  format: ExportFormat = 'markdown',
): Promise<{ content: string; contentType: string; filename: string } | null> {
  const db = getDb();

  const conversation = await db.aiConversation.findUnique({
    where: { id: conversationId },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!conversation) return null;

  const dateStr = conversation.createdAt.toISOString().slice(0, 10);
  const slug = conversation.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);

  switch (format) {
    case 'markdown':
      return {
        content: toMarkdown(conversation),
        contentType: 'text/markdown; charset=utf-8',
        filename: `${slug}-${dateStr}.md`,
      };
    case 'json':
      return {
        content: toJson(conversation),
        contentType: 'application/json; charset=utf-8',
        filename: `${slug}-${dateStr}.json`,
      };
    case 'csv':
      return {
        content: toCsv(conversation),
        contentType: 'text/csv; charset=utf-8',
        filename: `${slug}-${dateStr}.csv`,
      };
  }
}

// ── Formatters ──

interface ConversationWithMessages {
  id: string;
  title: string;
  type: string;
  nodeId: string | null;
  status: string;
  summary: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    toolCalls: string;
    tokenCount: number;
    createdAt: Date;
  }>;
}

function toMarkdown(conv: ConversationWithMessages): string {
  const lines: string[] = [];
  lines.push(`# ${conv.title}`);
  lines.push('');
  lines.push(`**Type:** ${conv.type} | **Status:** ${conv.status} | **Created:** ${conv.createdAt.toISOString()}`);
  if (conv.nodeId) lines.push(`**Node:** ${conv.nodeId}`);
  if (conv.summary) {
    lines.push('');
    lines.push(`> **Summary:** ${conv.summary}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of conv.messages) {
    if (msg.role === 'system') continue; // Skip system messages

    const roleLabel = msg.role === 'user' ? '🧑 **User**' :
                      msg.role === 'assistant' ? '🤖 **Magnus AI**' :
                      msg.role === 'tool' ? '🔧 **Tool**' : `**${msg.role}**`;

    const time = msg.createdAt.toLocaleString();
    lines.push(`### ${roleLabel} — ${time}`);
    lines.push('');

    // Content
    lines.push(msg.content);
    lines.push('');

    // Tool calls
    const toolCalls = parseToolCalls(msg.toolCalls);
    if (toolCalls.length > 0) {
      lines.push('**Tool Calls:**');
      for (const tc of toolCalls) {
        lines.push(`- \`${tc.name}\`: ${tc.success ? '✅' : '❌'} ${truncate(JSON.stringify(tc.result), 200)}`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  lines.push(`*Exported from Magnus AI on ${new Date().toISOString()}*`);
  return lines.join('\n');
}

function toJson(conv: ConversationWithMessages): string {
  return JSON.stringify({
    conversation: {
      id: conv.id,
      title: conv.title,
      type: conv.type,
      nodeId: conv.nodeId,
      status: conv.status,
      summary: conv.summary,
      createdBy: conv.createdBy,
      createdAt: conv.createdAt.toISOString(),
      updatedAt: conv.updatedAt.toISOString(),
    },
    messages: conv.messages.map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      toolCalls: parseToolCalls(m.toolCalls),
      tokenCount: m.tokenCount,
      createdAt: m.createdAt.toISOString(),
    })),
    exportedAt: new Date().toISOString(),
  }, null, 2);
}

function toCsv(conv: ConversationWithMessages): string {
  const rows: string[] = [];
  rows.push('timestamp,role,content,tool_calls,token_count');

  for (const msg of conv.messages) {
    if (msg.role === 'system') continue;
    const content = csvEscape(msg.content);
    const tools = csvEscape(msg.toolCalls !== '[]' ? msg.toolCalls : '');
    rows.push(`${msg.createdAt.toISOString()},${msg.role},${content},${tools},${msg.tokenCount}`);
  }

  return rows.join('\n');
}

// ── Helpers ──

function parseToolCalls(raw: string): Array<{ name: string; success: boolean; result: unknown }> {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '...' : str;
}

function csvEscape(str: string): string {
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
