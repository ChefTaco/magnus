import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnimatedNumber } from './animated-number';
import { EmptyState } from './empty-state';
import { Gauge } from './gauge';
import { GlowPanel } from './glow-panel';
import { MeterBar } from './meter-bar';
import { PageHeader } from './page-header';
import { Sparkline } from './sparkline';
import { StatusDot } from './status-dot';
import { StatCard } from './card';
import { thresholdTone } from '@/lib/theme-colors';

describe('UI primitives (server render)', () => {
  it('MeterBar exposes meter semantics and a threshold tone', () => {
    const html = renderToStaticMarkup(<MeterBar value={92} label="CPU" showValue testId="m" />);
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="92"');
    expect(html).toContain('aria-label="CPU"');
    expect(html).toContain('92%');
    expect(html).toContain('bg-danger');
    expect(html).toContain('data-testid="m"');
  });

  it('MeterBar renders an em dash for unknown values', () => {
    const html = renderToStaticMarkup(<MeterBar value={null} showValue />);
    expect(html).toContain('—');
    expect(html).not.toContain('aria-valuenow');
  });

  it('Gauge labels its value for assistive tech', () => {
    const html = renderToStaticMarkup(<Gauge value={7} max={10} label="Fleet online" higherIsBetter testId="g" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Fleet online: 70%"');
    expect(html).toContain('data-testid="g"');
  });

  it('Sparkline keeps its test id on the empty path', () => {
    expect(renderToStaticMarkup(<Sparkline values={[1]} testId="s" />)).toContain('data-testid="s"');
    const html = renderToStaticMarkup(<Sparkline values={[1, 5, 3]} testId="s" />);
    expect(html).toContain('<svg');
    expect(html).toContain('data-testid="s"');
  });

  it('AnimatedNumber renders the final value on the server', () => {
    expect(renderToStaticMarkup(<AnimatedNumber value={82} decimals={1} suffix="%" />)).toContain('82.0%');
    expect(renderToStaticMarkup(<AnimatedNumber value={null} />)).toContain('—');
  });

  it('PageHeader keeps the title as the only h1 text', () => {
    const html = renderToStaticMarkup(<PageHeader title="Fleet Overview" eyebrow="Fleet" description="x" />);
    expect(html).toMatch(/<h1[^>]*>Fleet Overview<\/h1>/);
  });

  it('GlowPanel, StatCard, StatusDot and EmptyState render', () => {
    expect(renderToStaticMarkup(<GlowPanel testId="p" title="Panel">body</GlowPanel>)).toContain('data-testid="p"');
    expect(renderToStaticMarkup(<StatCard label="Nodes" value={3} spark={[1, 2, 3]} meter={50} />)).toContain('role="meter"');
    expect(renderToStaticMarkup(<StatusDot status="ONLINE" />)).toContain('bg-success');
    expect(renderToStaticMarkup(<EmptyState title="Nothing" tone="danger" />)).toContain('role="alert"');
  });

  it('thresholdTone maps utilisation', () => {
    expect(thresholdTone(10)).toBe('success');
    expect(thresholdTone(75)).toBe('warning');
    expect(thresholdTone(95)).toBe('danger');
  });
});
