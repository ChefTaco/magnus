import { redirectToSecurityConsole } from '@/lib/security-console';

export default async function Page(): Promise<never> {
  return redirectToSecurityConsole('/security-fusion/policies');
}
