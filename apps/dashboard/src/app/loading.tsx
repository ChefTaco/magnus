import { SkeletonStatGrid, SkeletonTable } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="space-y-2">
        <div className="skeleton h-2 w-24 opacity-60" />
        <div className="skeleton h-5 w-56" />
      </div>
      <SkeletonStatGrid />
      <SkeletonTable rows={6} cols={5} />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
