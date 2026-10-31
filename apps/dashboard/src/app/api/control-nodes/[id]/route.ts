import { NextResponse } from 'next/server';
import type { ControlNodeMutation, StoredControlNode } from '@/lib/control-nodes';
import { toControlNodeDto, withNodesMutex } from '@/lib/control-nodes-store';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** PATCH /api/control-nodes/[id] — update a control node */
export async function PATCH(request: Request, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;
  const body = (await request.json()) as ControlNodeMutation;

  if (
    (body.name !== undefined && typeof body.name !== 'string')
    || (body.url !== undefined && typeof body.url !== 'string')
    || (body.apiSecret !== undefined && typeof body.apiSecret !== 'string')
    || (body.token !== undefined && typeof body.token !== 'string')
    || 'nodeManagerSecret' in (body as object)
  ) {
    return NextResponse.json(
      { success: false, error: 'Invalid control-node replacement fields' },
      { status: 400 },
    );
  }

  const result = await withNodesMutex<{ node: StoredControlNode } | null>((nodes) => {
    const idx = nodes.findIndex((n) => n.id === id);
    if (idx === -1) return { nodes, result: null };

    const node = nodes[idx]!;
    if (body.name !== undefined && body.name.trim()) node.name = body.name.trim();
    if (body.url !== undefined && body.url.trim()) node.url = body.url.trim().replace(/\/+$/, '');
    // Credential fields are write-only replacements. Empty/omitted values
    // preserve the current server-side credential rather than clearing it by
    // accident when an edit form cannot read the existing value.
    if (body.apiSecret) node.apiSecret = body.apiSecret;
    if (body.token) node.token = body.token;

    return { nodes, result: { node } };
  });

  if (!result) {
    return NextResponse.json(
      { success: false, error: 'Control node not found' },
      { status: 404 },
    );
  }

  return NextResponse.json({ success: true, data: toControlNodeDto(result.node) });
}

/** DELETE /api/control-nodes/[id] — remove a control node */
export async function DELETE(_request: Request, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;

  const deleted = await withNodesMutex<boolean>((nodes) => {
    const filtered = nodes.filter((n) => n.id !== id);
    if (filtered.length === nodes.length) return { nodes, result: false };
    return { nodes: filtered, result: true };
  });

  if (!deleted) {
    return NextResponse.json(
      { success: false, error: 'Control node not found' },
      { status: 404 },
    );
  }

  return NextResponse.json({ success: true, data: { deleted: id } });
}
