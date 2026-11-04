import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings, SettingsSchema, SettingsStore, SettingsValidationError } from '../../src/config/settings.js';
import { loadEnv, parseDotEnv } from '../../src/config/env.js';
import { ErpNextClient, ErpNextError, extractFrappeError, normalizeColumn, normalizeErpNextUrl } from '../../src/erpnext/client.js';
import { Auth, parseCookies, verifyFrappeSignature } from '../../src/web/auth.js';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asms-test-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('settings', () => {
  it('has sensible defaults matching the agreed setup', () => {
    const s = defaultSettings();
    expect(s.general.testMode).toBe(true);
    expect(s.invoices.sales.sendToParty).toBe(true);
    expect(s.invoices.purchase.sendToParty).toBe(true);
    expect(s.reports.items.map((r) => r.type)).toEqual(['daily_sales', 'receivables', 'payables', 'stock_alerts', 'cash_bank']);
    expect(s.reports.items[0].options).toMatchObject({ day: 'today', topCustomers: 5 });
  });

  it('fills in missing fields from an old/partial file', () => {
    const s = SettingsSchema.parse({ general: { defaultCountryCode: '971' }, reports: { items: [{ id: 'x', type: 'stock_alerts' }] } });
    expect(s.general.defaultCountryCode).toBe('971');
    expect(s.general.sendDelaySeconds).toBe(5);
    expect(s.reports.items[0]).toMatchObject({ id: 'x', enabled: true, options: { basedOn: 'actual_qty', sendWhenEmpty: false } });
    expect(s.invoices.purchase.partyMessage).toContain('{{bill_no}}');
  });

  it('persists, applies env overrides and rejects invalid input', () => {
    const dir = tmpDir();
    const store = new SettingsStore(dir, { erpnextUrl: 'https://env.example.com' });
    expect(fs.existsSync(path.join(dir, 'settings.json'))).toBe(true);
    expect(store.get().erpnext.url).toBe('https://env.example.com');
    expect(store.lockedFields()).toEqual(['erpnext.url']);

    const next = store.get();
    next.general.defaultCountryCode = '254';
    store.update(next);
    expect(new SettingsStore(dir).get().general.defaultCountryCode).toBe('254');

    expect(() => store.update({ ...next, general: { ...next.general, defaultCountryCode: '+971' } })).toThrow(SettingsValidationError);
    const dup = structuredClone(next);
    dup.reports.items.push(structuredClone(dup.reports.items[0]));
    expect(() => store.update(dup)).toThrow(/share the id/);
  });
});

describe('time zone fallback', () => {
  it('never returns an invalid zone, even with an empty TZ variable', async () => {
    const { ContextResolver } = await import('../../src/erpnext/context.js');
    const { isValidTimeZone } = await import('../../src/util/time.js');
    const before = process.env.TZ;
    process.env.TZ = '';
    try {
      const tz = new ContextResolver(() => ({}) as never, () => defaultSettings()).fallbackTimezone();
      expect(isValidTimeZone(tz)).toBe(true);
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});

describe('env', () => {
  it('parses .env files', () => {
    expect(parseDotEnv('# c\nA=1\nB="two words"\nexport C=3 # note\nD=\n')).toEqual({ A: '1', B: 'two words', C: '3', D: '' });
  });

  it('requires a dashboard password and applies defaults', () => {
    expect(() => loadEnv({}, '/nonexistent')).toThrow(/ADMIN_PASSWORD/);
    const env = loadEnv({ ADMIN_PASSWORD: 'long-enough', ERPNEXT_URL: '', TRUST_PROXY: 'true' } as NodeJS.ProcessEnv, '/nonexistent');
    expect(env.PORT).toBe(3000);
    expect(env.ERPNEXT_URL).toBeUndefined();
    expect(env.TRUST_PROXY).toBe(true);
    expect(env.WHATSAPP_DRIVER).toBe('baileys');
  });
});

describe('ErpNextClient', () => {
  function mockFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fn = (async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      return handler(url, init);
    }) as typeof fetch;
    return { fn, calls };
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('normalises the site address', () => {
    expect(normalizeErpNextUrl('erp.example.com/')).toBe('https://erp.example.com');
    expect(normalizeErpNextUrl('https://erp.example.com/app/sales-invoice')).toBe('https://erp.example.com');
    expect(normalizeErpNextUrl('http://10.0.0.5:8000')).toBe('http://10.0.0.5:8000');
  });

  it('sends token auth and encodes list queries', async () => {
    const { fn, calls } = mockFetch(() => json({ data: [{ name: 'SINV-1' }] }));
    const erp = new ErpNextClient({ url: 'https://erp.test', apiKey: 'k', apiSecret: 's' }, fn);
    const rows = await erp.getList('Sales Invoice', { fields: ['name'], filters: [['docstatus', '=', 1]], orderBy: 'modified asc', limit: 5 });
    expect(rows).toEqual([{ name: 'SINV-1' }]);
    const { url, init } = calls[0];
    expect(url.pathname).toBe('/api/resource/Sales%20Invoice');
    expect(url.searchParams.get('filters')).toBe('[["docstatus","=",1]]');
    expect(url.searchParams.get('limit_page_length')).toBe('5');
    expect((init.headers as Record<string, string>).Authorization).toBe('token k:s');
  });

  it('pages through getAll', async () => {
    const { fn, calls } = mockFetch((url) => {
      const start = Number(url.searchParams.get('limit_start'));
      return json({ data: start === 0 ? [{ name: 'a' }, { name: 'b' }] : [{ name: 'c' }] });
    });
    const erp = new ErpNextClient({ url: 'https://erp.test', apiKey: 'k', apiSecret: 's' }, fn);
    expect(await erp.getAll('Item', { pageSize: 2 })).toHaveLength(3);
    expect(calls).toHaveLength(2);
  });

  it('turns Frappe errors into readable messages', async () => {
    const serverMessages = JSON.stringify([JSON.stringify({ message: '<b>Customer</b> is mandatory' })]);
    expect(extractFrappeError({ _server_messages: serverMessages, exc_type: 'ValidationError' })).toEqual({ message: 'Customer is mandatory', excType: 'ValidationError' });
    expect(extractFrappeError({ exception: 'frappe.exceptions.DoesNotExistError: Sales Invoice X not found' }).message).toBe('Sales Invoice X not found');

    const { fn } = mockFetch(() => json({ exc_type: 'AuthenticationError' }, 401));
    const erp = new ErpNextClient({ url: 'https://erp.test', apiKey: 'k', apiSecret: 'bad' }, fn);
    const error = await erp.getLoggedUser().catch((e) => e);
    expect(error).toBeInstanceOf(ErpNextError);
    expect(error.message).toMatch(/rejected the API key/);
    expect(error.permanent).toBe(true);
  });

  it('explains unreachable sites and non-API pages', async () => {
    const down = new ErpNextClient({ url: 'https://erp.test', apiKey: 'k', apiSecret: 's' }, (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as typeof fetch);
    await expect(down.getLoggedUser()).rejects.toThrow(/Cannot reach ERPNext.*ECONNREFUSED/);

    const { fn } = mockFetch(() => new Response('<html>hello</html>', { headers: { 'content-type': 'text/html' } }));
    const html = new ErpNextClient({ url: 'https://erp.test', apiKey: 'k', apiSecret: 's' }, fn);
    await expect(html.getLoggedUser()).rejects.toThrow(/web page instead of the API/);
  });

  it('downloads PDFs and validates them', async () => {
    const { fn, calls } = mockFetch(() => new Response(Buffer.from('%PDF-1.4 data'), { headers: { 'content-type': 'application/pdf' } }));
    const erp = new ErpNextClient({ url: 'https://erp.test', apiKey: 'k', apiSecret: 's' }, fn);
    const pdf = await erp.downloadPdf('Sales Invoice', 'SINV-1', { printFormat: 'My Format', pdfGenerator: 'wkhtmltopdf' });
    expect(pdf.toString()).toContain('%PDF');
    expect(calls[0].url.searchParams.get('format')).toBe('My Format');
    expect(calls[0].url.searchParams.get('pdf_generator')).toBe('wkhtmltopdf');

    const bad = new ErpNextClient({ url: 'https://erp.test', apiKey: 'k', apiSecret: 's' }, mockFetch(() => json({ exc_type: 'RuntimeError', exception: 'RuntimeError: Connection error.' }, 500)).fn);
    await expect(bad.downloadPdf('Sales Invoice', 'SINV-1')).rejects.toThrow(/could not create the PDF.*wkhtmltopdf/s);
  });

  it('normalises query report columns and list rows', async () => {
    expect(normalizeColumn('Posting Date:Date:90')).toEqual({ label: 'Posting Date', fieldname: 'posting_date', fieldtype: 'Date', options: undefined });
    expect(normalizeColumn('Customer:Link/Customer:120')).toMatchObject({ fieldname: 'customer', fieldtype: 'Link', options: 'Customer' });
    const { fn } = mockFetch(() => json({ message: { columns: ['Customer:Link/Customer:120', { fieldname: 'amount', label: 'Amount', fieldtype: 'Currency' }], result: [['Acme', 10], { customer: 'Beta', amount: 5 }] } }));
    const erp = new ErpNextClient({ url: 'https://erp.test', apiKey: 'k', apiSecret: 's' }, fn);
    const report = await erp.runQueryReport('Test', {});
    expect(report.rows).toEqual([{ customer: 'Acme', amount: 10 }, { customer: 'Beta', amount: 5 }]);
  });
});

describe('dashboard auth and webhook signatures', () => {
  it('verifies ERPNext webhook signatures (base64 HMAC-SHA256 of the body)', () => {
    // Exactly what Frappe sends: requests' json= body is json.dumps(data) with Python's default separators.
    const body = Buffer.from('{"doctype": "Sales Invoice", "name": "ACC-SINV-2026-00001"}');
    const signature = crypto.createHmac('sha256', 'secret').update(body).digest('base64');
    expect(verifyFrappeSignature(body, signature, 'secret')).toBe(true);
    expect(verifyFrappeSignature(body, signature, 'other')).toBe(false);
    expect(verifyFrappeSignature(body, undefined, 'secret')).toBe(false);
  });

  it('checks passwords and session cookies', () => {
    const auth = new Auth('correct horse battery');
    expect(auth.checkPassword('correct horse battery')).toBe(true);
    expect(auth.checkPassword('wrong')).toBe(false);
    let cookie = '';
    const res = { cookie: (_n: string, value: string) => (cookie = value) } as any;
    auth.issue(res, false);
    expect(auth.isValid({ headers: { cookie: `asms_session=${cookie}` } } as any)).toBe(true);
    expect(auth.isValid({ headers: { cookie: `asms_session=${cookie.slice(0, -2)}xx` } } as any)).toBe(false);
    expect(new Auth('another password').isValid({ headers: { cookie: `asms_session=${cookie}` } } as any)).toBe(false);
    expect(parseCookies('a=1; b=hello%20world')).toEqual({ a: '1', b: 'hello world' });
  });

  it('locks out after repeated wrong passwords', () => {
    const auth = new Auth('pw-pw-pw-pw');
    for (let i = 0; i < 5; i++) auth.recordFailure('1.2.3.4');
    expect(auth.isLockedOut('1.2.3.4')).toBe(true);
    expect(auth.isLockedOut('5.6.7.8')).toBe(false);
  });
});
