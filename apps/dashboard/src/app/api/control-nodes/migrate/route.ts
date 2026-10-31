import { NextResponse } from 'next/server';

/** Legacy SSH/password migration is intentionally unavailable. */
export async function POST(): Promise<NextResponse> {
  return NextResponse.json({
    success: false,
    error: 'In-band node migration is retired; use the reviewed key-only deployment runbook.',
  }, { status: 410 });
}
