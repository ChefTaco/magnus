import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { HTMLAttributes, ReactNode } from 'react';
import { GlowPanel } from './glow-panel';
import { MeterBar } from './meter-bar';
import { Sparkline } from './sparkline';
import { TONE_TEXT, type Tone } from '@/lib/theme-colors';

interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
  tone?: Tone;
  corners?: boolean;
}

export function Card({ title, description, children, className, action, tone, corners = false, ...props }: CardProps): React.ReactElement {
  return (
    <GlowPanel {...props} tone={tone} corners={corners} title={title} description={description} action={action} className={className}>
      {children}
    </GlowPanel>
  );
}

interface StatCardProps {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  trend?: { value: string; positive: boolean };
  /** Recent samples drawn as a sparkline under the value. */
  spark?: number[];
  /** 0–100 utilisation shown as a meter. */
  meter?: number | null;
  /** Change since the previous sample. */
  delta?: { value: number; unit?: string; /** Higher is better (green when up). */ positiveIsGood?: boolean };
  tone?: Tone;
  className?: string;
  testId?: string;
}

export function StatCard({ label, value, icon, trend, spark, meter, delta, tone = 'primary', className, testId }: StatCardProps): React.ReactElement {
  const deltaGood = delta ? (delta.value >= 0) === (delta.positiveIsGood ?? true) : true;
  return (
    <GlowPanel tone={tone} className={cn('overflow-hidden', className)} testId={testId}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-[0.15em] text-text-muted">{label}</span>
        {icon && <span className="text-primary/60">{icon}</span>}
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <div className={cn('num text-2xl font-bold', tone === 'primary' ? 'text-primary neon-text' : TONE_TEXT[tone])}>{value}</div>
        {delta && delta.value !== 0 && (
          <span className={cn('num mb-1 inline-flex items-center gap-0.5 text-[11px]', deltaGood ? 'text-success' : 'text-danger')}>
            {delta.value > 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
            {Math.abs(delta.value).toFixed(Number.isInteger(delta.value) ? 0 : 1)}
            {delta.unit}
          </span>
        )}
      </div>
      {trend && (
        <div className={cn('mt-1 text-[11px]', trend.positive ? 'text-success' : 'text-danger')}>
          {trend.value}
        </div>
      )}
      {meter !== undefined && <MeterBar value={meter} className="mt-3" label={label} />}
      {spark && spark.length > 1 && (
        <div className="-mx-5 -mb-5 mt-3 opacity-80">
          <Sparkline values={spark} tone={tone} width={240} height={28} stretch live={false} />
        </div>
      )}
    </GlowPanel>
  );
}
