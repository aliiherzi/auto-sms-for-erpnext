import { describe, expect, it } from 'vitest';
import { currencyPrecision, formatMoney, safeFileName, stripHtml } from '../../src/util/format.js';
import { normalizePhone, isGroupJid, isJid } from '../../src/util/phone.js';
import { renderTemplate, templateVariables } from '../../src/util/template.js';
import { addDays, daysBetween, formatDate, monthStart, todayInTz, weekStart, yearStart } from '../../src/util/time.js';

describe('normalizePhone', () => {
  it.each([
    ['+971 50 123 4567', '', '971501234567'],
    ['+971-50-123-4567', '', '971501234567'],
    ['00971501234567', '', '971501234567'],
    ['0501234567', '971', '971501234567'],
    ['050 123 4567', '971', '971501234567'],
    ['501234567', '971', '971501234567'],
    ['971501234567', '971', '971501234567'],
    ['(555) 123-4567', '1', '15551234567'],
    ['0712 345 678', '254', '254712345678'],
    ['+44 7911 123456 ext. 12', '', '447911123456'],
    ['0501234567 / 0559876543', '971', '971501234567'],
    ['+966 55 123 4567, +966 50 000 0000', '', '966551234567'],
  ])('%s (cc %s) → %s', (raw, cc, expected) => {
    expect(normalizePhone(raw, cc)).toBe(expected);
  });

  it('rejects things that cannot be numbers', () => {
    expect(normalizePhone('', '971')).toBeNull();
    expect(normalizePhone(null, '971')).toBeNull();
    expect(normalizePhone('n/a', '971')).toBeNull();
    expect(normalizePhone('12345', '')).toBeNull();
    expect(normalizePhone('+1234567890123456', '')).toBeNull();
  });

  it('cannot guess the country of a local number without a default country code', () => {
    expect(normalizePhone('0501234567', '')).toBeNull();
  });

  it('recognises JIDs', () => {
    expect(isGroupJid('120363000000000001@g.us')).toBe(true);
    expect(isJid('971501234567@s.whatsapp.net')).toBe(true);
    expect(isJid('971501234567')).toBe(false);
  });
});

describe('renderTemplate', () => {
  const vars = { name: 'SINV-1', party_name: 'Acme', due_date: '14-11-2026', empty: '', doc: { po_no: 'PO-9', nested: { a: 1 } } };

  it('replaces variables, including nested ones', () => {
    expect(renderTemplate('Hi {{party_name}}, {{ name }} / {{doc.po_no}} / {{doc.nested.a}}', vars)).toBe('Hi Acme, SINV-1 / PO-9 / 1');
  });

  it('renders optional sections only when the value is set', () => {
    expect(renderTemplate('{{#due_date}}Due {{due_date}}{{/due_date}}', vars)).toBe('Due 14-11-2026');
    expect(renderTemplate('{{#empty}}Never{{/empty}}', vars)).toBe('');
    expect(renderTemplate('{{^empty}}Shown when empty{{/empty}}', vars)).toBe('Shown when empty');
  });

  it('removes lines that become empty but keeps intended blank lines', () => {
    const tpl = 'Dear {{party_name}},\n\nInvoice {{name}}\n{{#empty}}Ref: {{empty}}{{/empty}}\n{{missing}}\nThanks';
    expect(renderTemplate(tpl, vars)).toBe('Dear Acme,\n\nInvoice SINV-1\nThanks');
  });

  it('supports multi-line sections', () => {
    expect(renderTemplate('A\n{{#empty}}\nB\n{{/empty}}\nC', vars)).toBe('A\nC');
    expect(renderTemplate('A\n{{#name}}\nB\n{{/name}}\nC', vars)).toBe('A\nB\nC');
  });

  it('lists template variables', () => {
    expect(templateVariables('{{a}} {{#b}}{{c}}{{/b}}')).toEqual(['a', 'b', 'c']);
  });
});

describe('dates', () => {
  it('computes today in a time zone', () => {
    const instant = new Date('2026-11-04T21:30:00Z');
    expect(todayInTz('Asia/Dubai', instant)).toBe('2026-11-05');
    expect(todayInTz('America/New_York', instant)).toBe('2026-11-04');
    expect(todayInTz('Not/AZone', instant)).toBe('2026-11-04'); // falls back to UTC
  });

  it('does date arithmetic on YYYY-MM-DD strings', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(monthStart('2026-11-04')).toBe('2026-11-01');
    expect(yearStart('2026-11-04')).toBe('2026-01-01');
    expect(weekStart('2026-11-04')).toBe('2026-11-02'); // Wednesday → Monday
    expect(daysBetween('2026-10-05', '2026-11-04')).toBe(30);
  });

  it('formats dates', () => {
    expect(formatDate('2026-11-04', 'DD-MM-YYYY')).toBe('04-11-2026');
    expect(formatDate('2026-11-04', 'MM/DD/YYYY')).toBe('11/04/2026');
    expect(formatDate('2026-11-04 10:00:00', 'DD MMM YYYY')).toBe('04 Nov 2026');
    expect(formatDate(null, 'DD-MM-YYYY')).toBe('');
  });
});

describe('money', () => {
  it('uses the right number of decimals per currency', () => {
    expect(currencyPrecision('AED')).toBe(2);
    expect(currencyPrecision('KWD')).toBe(3);
    expect(currencyPrecision('JPY')).toBe(0);
    expect(formatMoney(1250, 'AED')).toBe('AED 1,250.00');
    expect(formatMoney('1234.5678', 'KWD')).toBe('KWD 1,234.568');
    expect(formatMoney(-500, 'USD', 'de-DE')).toBe('USD -500,00');
  });

  it('cleans ERPNext HTML and file names', () => {
    expect(stripHtml('<b>Customer</b> is required<br>Check &amp; retry')).toBe('Customer is required\nCheck & retry');
    expect(safeFileName('ACC-SINV/2026 001')).toBe('ACC-SINV-2026-001');
  });
});
