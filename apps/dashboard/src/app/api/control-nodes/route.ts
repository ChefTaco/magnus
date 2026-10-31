import { NextResponse } from 'next/server';
import type { ControlNodeMutation, StoredControlNode } from '@/lib/control-nodes';
import { DEFAULT_CONTROL_NODE, generateNodeId } from '@/lib/control-nodes';
import { readNodes, toControlNodeDto, withNodesMutex } from '@/lib/control-nodes-store';

/** GET /api/control-nodes — list all control nodes */
export async function GET(): Promise<NextResponse> {
  const nodes = await readNodes();
  return NextResponse.json({ success: true, data: [{ ...DEFAULT_CONTROL_NODE, url: process.env['CONTROL_API_URL'] ?? '' }, ...nodes.filter(n => n.id !== 'local').map(toControlNodeDto)] });
}

/** POST /api/control-nodes — add a new control node */
export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as ControlNodeMutation;

  if (typeof body.name !== 'string' || !body.name.trim() || typeof body.url !== 'string' || !body.url.trim()) {
    return NextResponse.json(
      { success: false, error: 'Name and URL are required' },
      { status: 400 },
    );
  }
  if (
    (body.apiSecret !== undefined && typeof body.apiSecret !== 'string')
    || (body.token !== undefined && typeof body.token !== 'string')
    || 'nodeManagerSecret' in (body as object)
  ) {
    return NextResponse.json(
      { success: false, error: 'Credential replacements must be strings' },
      { status: 400 },
    );
  }

  const newNode = await withNodesMutex<StoredControlNode>((nodes) => {
    const node: StoredControlNode = {
      id: generateNodeId(),
      name: body.name!.trim(),
      url: body.url!.trim().replace(/\/+$/, ''),
      apiSecret: body.apiSecret || undefined,
      token: body.token || undefined,
      createdAt: new Date().toISOString(),
    };
    nodes.push(node);
    return { nodes, result: node };
  });

  return NextResponse.json({ success: true, data: toControlNodeDto(newNode) }, { status: 201 });
}
