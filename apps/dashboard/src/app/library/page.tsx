import { fleetFetch } from '@/lib/fleet-fetch';
import LibraryPageClient from './library-client';
import type { CategoryRow, FileRow } from './library-client';

export default async function LibraryPage(): Promise<React.ReactElement> {
  let initialCategories: CategoryRow[] = [];
  let initialFiles: FileRow[] = [];
  let initialTotalFiles = 0;

  try {
    const [catRes, fileRes] = await Promise.all([
      fleetFetch<{ success: boolean; data: CategoryRow[] }>('library/categories').catch(() => null),
      fleetFetch<{ success: boolean; data: FileRow[]; pagination?: { total: number } }>('library/files?pageSize=100').catch(() => null),
    ]);
    if (catRes?.success) initialCategories = catRes.data;
    if (fileRes?.success) {
      initialFiles = fileRes.data;
      initialTotalFiles = fileRes.pagination?.total ?? fileRes.data.length;
    }
  } catch {
    // Control node unreachable at SSR time — client will retry
  }

  return (
    <LibraryPageClient
      initialCategories={initialCategories}
      initialFiles={initialFiles}
      initialTotalFiles={initialTotalFiles}
    />
  );
}
