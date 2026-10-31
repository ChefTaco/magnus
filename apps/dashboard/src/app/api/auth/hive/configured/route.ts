import { NextResponse } from 'next/server';
import { hiveLoginConfigured } from '@/lib/hive-login';
export function GET() {
  return NextResponse.json({ configured: hiveLoginConfigured() });
}
