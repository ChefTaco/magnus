import { fleetFetch } from '@/lib/fleet-fetch';
import RolesPageClient from './roles-client';
import type { RoleData } from './roles-client';

export default async function RolesPage(): Promise<React.ReactElement> {
  let initialRoles: RoleData[] = [];
  try {
    const res = await fleetFetch<{ success: boolean; data: RoleData[] }>('roles');
    if (res.success) initialRoles = res.data;
  } catch {
    // Control node unreachable at SSR time — client will retry
  }

  return <RolesPageClient initialRoles={initialRoles} />;
}
