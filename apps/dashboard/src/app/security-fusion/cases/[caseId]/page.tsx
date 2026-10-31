import { redirectToSecurityConsole } from '@/lib/security-console';

export default async function Page({ params }: { params: Promise<{ caseId: string }> }): Promise<never> {
  const { caseId } = await params;
  return redirectToSecurityConsole(`/security-fusion/cases/${encodeURIComponent(caseId)}`);
}
