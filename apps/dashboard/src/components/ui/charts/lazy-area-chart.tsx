'use client';

import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';

export type { AreaSeries, NeonAreaChartProps } from './area-chart';

/** recharts stays out of the route bundle until a chart actually renders. */
export const LazyAreaChart = dynamic(() => import('./area-chart'), {
  ssr: false,
  loading: () => <Skeleton className="h-[180px] w-full" />,
});
