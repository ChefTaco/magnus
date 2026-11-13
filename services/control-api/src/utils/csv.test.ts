import { describe, expect, it } from 'vitest';
import { csvCell, csvRow } from './csv.js';

describe('CSV export cells', () => {
  it('quotes every cell and doubles embedded quotes', () => {
    expect(csvRow(['2026-11-13T00:00:00.000Z', 'command.dispatch', 'key","forged","column', null, undefined, 7]))
      .toBe('"2026-11-13T00:00:00.000Z","command.dispatch","key"",""forged"",""column","","","7"');
  });

  it('keeps a line break inside its cell', () => {
    expect(csvCell('first\nsecond')).toBe('"first\nsecond"');
  });

  it.each(['=HYPERLINK("https://example.com","open")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd'])('stops a spreadsheet evaluating %j', (value) => {
    expect(csvCell(value).startsWith(`"'`)).toBe(true);
  });

  it('leaves ordinary text alone', () => {
    expect(csvCell('systemctl restart nginx')).toBe('"systemctl restart nginx"');
    expect(csvCell('{"exitCode":-1}')).toBe('"{""exitCode"":-1}"');
  });
});
