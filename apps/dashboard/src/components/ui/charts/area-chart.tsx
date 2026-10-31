'use client';

import { useId, useMemo } from 'react';
import { Area, AreaChart as RAreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { TONE_VAR, type Tone } from '@/lib/theme-colors';

export interface AreaSeries {
  key: string;
  label: string;
  tone: Tone;
}

export interface NeonAreaChartProps {
  data: Array<Record<string, number | string | null>>;
  xKey: string;
  series: AreaSeries[];
  height?: number;
  /** Fix the Y axis to 0–100 and add a % suffix. */
  percent?: boolean;
  formatX?: (value: string | number) => string;
  className?: string;
  testId?: string;
}

/** Themed recharts area chart. Only imported through `lazy-area-chart.tsx`. */
export default function NeonAreaChart({
  data,
  xKey,
  series,
  height = 180,
  percent = false,
  formatX,
  className,
  testId,
}: NeonAreaChartProps): React.ReactElement {
  const reduced = useReducedMotion();
  const idBase = useId().replace(/:/g, '');
  const tickStyle = useMemo(() => ({ fill: 'var(--color-text-muted)', fontSize: 10, fontFamily: 'var(--font-mono)' }), []);

  return (
    <div className={className} style={{ height }} data-testid={testId}>
      <ResponsiveContainer width="100%" height="100%">
        <RAreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <defs>
            {series.map((s) => (
              <linearGradient key={s.key} id={`${idBase}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={TONE_VAR[s.tone]} stopOpacity={0.35} />
                <stop offset="100%" stopColor={TONE_VAR[s.tone]} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey={xKey}
            tick={tickStyle}
            tickLine={false}
            axisLine={{ stroke: 'var(--color-border)' }}
            tickFormatter={formatX}
            minTickGap={24}
          />
          <YAxis
            tick={tickStyle}
            tickLine={false}
            axisLine={false}
            domain={percent ? [0, 100] : ['auto', 'auto']}
            tickFormatter={percent ? (v: number) => `${v}%` : undefined}
            width={44}
          />
          <Tooltip
            cursor={{ stroke: 'var(--color-primary)', strokeOpacity: 0.4 }}
            contentStyle={{
              background: 'var(--color-surface)',
              border: '1px solid color-mix(in srgb, var(--color-primary) 35%, transparent)',
              borderRadius: 6,
              boxShadow: '0 0 16px var(--color-glow)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
            }}
            labelStyle={{ color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}
            labelFormatter={formatX ? (v) => formatX(v as string | number) : undefined}
            formatter={(value, name) => [
              typeof value === 'number' ? `${value.toFixed(1)}${percent ? '%' : ''}` : String(value),
              name,
            ]}
          />
          {series.map((s) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={TONE_VAR[s.tone]}
              strokeWidth={1.5}
              fill={`url(#${idBase}-${s.key})`}
              dot={false}
              activeDot={{ r: 3, strokeWidth: 0, fill: TONE_VAR[s.tone] }}
              isAnimationActive={!reduced}
              animationDuration={800}
              connectNulls
            />
          ))}
        </RAreaChart>
      </ResponsiveContainer>
    </div>
  );
}
