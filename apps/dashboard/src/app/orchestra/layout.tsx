import type { ReactNode } from 'react';
import { HermesGate } from '@/components/integrations/hermes-gate';

export default function Layout({ children }: { children: ReactNode }): React.ReactElement {
  return <HermesGate>{children}</HermesGate>;
}
