/**
 * End-to-end test against a REAL ERPNext site (see README → "Running the tests").
 *
 * WhatsApp is replaced by the in-memory FakeWhatsApp so every message that would
 * be sent can be inspected (including the real PDF bytes ERPNext generates).
 *
 * Needs: ERPNEXT_TEST_URL, ERPNEXT_TEST_KEY/SECRET (the limited API user) and
 * ERPNEXT_TEST_ADMIN_KEY/SECRET (to create test documents). Skipped otherwise.
 */
import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { App } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { createLogger } from '../../src/util/logger.js';
import { FakeWhatsApp } from '../../src/whatsapp/fake.js';
import { createServer } from '../../src/web/server.js';
import { Admin, BRANCH, seed } from './seed.js';

const URL_ = process.env.ERPNEXT_TEST_URL;
const PORT = Number(process.env.TEST_PORT || 3201);
const WEBHOOK_HOST = process.env.WEBHOOK_HOST || 'host.docker.internal';
const OUTPUT = process.env.TEST_OUTPUT_DIR;

const MGMT = '120363000000000001@g.us';
const ACCOUNTS = '120363000000000002@g.us';
const BRANCH_GROUP = '120363000000000009@g.us';

describe.skipIf(!URL_)('real ERPNext end-to-end', () => {
  let app: App;
  let server: Server;
  let admin: Admin;
  let dataDir: string;
  let webhookName: string | null = null;
  const phones = new Map<string, FakeWhatsApp>();
  const main = () => phones.get('main')!;
  const branch = () => phones.get('branch')!;

  async function flush() {
    for (const id of app.whatsapp.ids()) {
      for (let m = app.db.nextQueuedMessage(id); m; m = app.db.nextQueuedMessage(id)) await app.outbox.deliver(m);
    }
  }

  function save(name: string, data: string | Buffer) {
    if (!OUTPUT) return;
    fs.mkdirSync(OUTPUT, { recursive: true });
    fs.writeFileSync(path.join(OUTPUT, name), data);
  }

  async function newInvoiceSent(name: string, timeoutMs = 30_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (app.db.messagesForDoc('Sales Invoice', name).length) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  beforeAll(async () => {
    admin = new Admin({ url: URL_!, key: process.env.ERPNEXT_TEST_ADMIN_KEY!, secret: process.env.ERPNEXT_TEST_ADMIN_SECRET! });
    await seed(admin);

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asms-int-'));
    const env = loadEnv(
      {
        ADMIN_PASSWORD: 'integration-test-password',
        DATA_DIR: dataDir,
        ERPNEXT_URL: URL_,
        ERPNEXT_API_KEY: process.env.ERPNEXT_TEST_KEY,
        ERPNEXT_API_SECRET: process.env.ERPNEXT_TEST_SECRET,
        WEBHOOK_SECRET: 'integration-webhook-secret',
        PORT: String(PORT),
        WHATSAPP_DRIVER: 'fake',
      } as NodeJS.ProcessEnv,
      '/nonexistent',
    );
    app = new App(env, createLogger(process.env.TEST_LOG_LEVEL || 'warn'), {
      manual: true,
      whatsappFactory: (id) => {
        const phone =
          id === 'branch'
            ? new FakeWhatsApp([{ id: BRANCH_GROUP, name: 'Branch team', size: 4, announce: false, isAdmin: true }])
            : new FakeWhatsApp();
        phones.set(id, phone);
        return phone;
      },
    });

    const s = app.settings();
    s.general.defaultCountryCode = '971';
    s.general.testMode = false;
    // ERPNext v16 downloads Chrome for PDFs on first use; the test site has no internet access.
    s.invoices.pdfGenerator = 'wkhtmltopdf';
    s.whatsapp.accounts = [
      { id: 'main', label: 'Head office' },
      { id: 'branch', label: 'Branch' },
    ];
    s.companies = [
      { company: '', accountId: 'main', salesGroups: [MGMT], purchaseGroups: [ACCOUNTS], reportGroups: [MGMT] },
      { company: BRANCH, accountId: 'branch', salesGroups: [BRANCH_GROUP], purchaseGroups: [], reportGroups: [BRANCH_GROUP] },
    ];
    app.settingsStore.update(s);
    await app.start();
    server = createServer(app).listen(PORT, '0.0.0.0');
  }, 300_000);

  afterAll(async () => {
    if (webhookName) await admin.call('frappe.client.delete', { doctype: 'Webhook', name: webhookName }).catch(() => undefined);
    server?.close();
    await app?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('connects to ERPNext with the limited API user', () => {
    const check = app.lastErpCheck!;
    expect(check.ok).toBe(true);
    expect(check.user).toBe('whatsapp-bot@example.com');
    expect(check.versions?.erpnext).toMatch(/^\d+\./);
    expect(check.timezone).toBe('Asia/Dubai');
    expect(check.companies).toEqual(expect.arrayContaining(['Demo Trading LLC', BRANCH]));
    expect(app.whatsapp.list().map((a) => [a.id, a.state.status])).toEqual([
      ['main', 'connected'],
      ['branch', 'connected'],
    ]);
  });

  it('starts watching without sending invoices that already exist', async () => {
    await app.watcher.pollOnce();
    await flush();
    expect(main().sent).toHaveLength(0);
    expect(app.db.getKv('watch:Sales Invoice:baseline_date')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  let acmeInvoice = '';
  it('sends a new customer invoice with its real PDF to the customer and the group', async () => {
    const inv = await admin.salesInvoice('Acme Trading', { qty: 1, rate: 777 });
    acmeInvoice = inv.name;
    await app.watcher.pollOnce();
    await flush();
    const sent = main().sent.filter((m) => m.document?.fileName === `${inv.name}.pdf`);
    expect(sent.map((m) => m.jid).sort()).toEqual([MGMT, '971501234567@s.whatsapp.net'].sort());
    const toCustomer = sent.find((m) => m.jid.endsWith('@s.whatsapp.net'))!;
    expect(toCustomer.document!.data.subarray(0, 5).toString()).toBe('%PDF-');
    expect(toCustomer.document!.size).toBeGreaterThan(5_000);
    expect(toCustomer.document!.caption).toContain(`*${inv.name}*`);
    expect(toCustomer.document!.caption).toContain('AED 777.00');
    save('customer-invoice.pdf', toCustomer.document!.data);
    save('customer-invoice-caption.txt', toCustomer.document!.caption ?? '');
    save('group-copy-caption.txt', sent.find((m) => m.jid === MGMT)!.document!.caption ?? '');
  }, 120_000);

  it('uses the default country code for local numbers (0559876543 → +971559876543)', async () => {
    const inv = await admin.salesInvoice('Gamma Foods', { qty: 1, rate: 120 });
    await app.watcher.pollOnce();
    await flush();
    expect(main().sent.some((m) => m.document?.fileName === `${inv.name}.pdf` && m.jid === '971559876543@s.whatsapp.net')).toBe(true);
  }, 120_000);

  it('records a clear error when the customer has no mobile number', async () => {
    const inv = await admin.salesInvoice('Beta Stores', { qty: 1, rate: 50 });
    await app.watcher.pollOnce();
    await flush();
    const messages = app.db.messagesForDoc('Sales Invoice', inv.name);
    const party = messages.find((m) => m.audience === 'party')!;
    expect(party.status).toBe('failed');
    expect(party.error).toMatch(/Beta Stores has no mobile number/);
    const groupCopy = main().sent.find((m) => m.document?.fileName === `${inv.name}.pdf`)!;
    expect(groupCopy.jid).toBe(MGMT);
    expect(groupCopy.document!.caption).toMatch(/Not sent to the customer/);
  }, 120_000);

  it('sends supplier invoices to the supplier and to the accounts group', async () => {
    const inv = await admin.purchaseInvoice('Delta Supplies', { billNo: `DS-${Date.now() % 100000}`, qty: 2, rate: 210 });
    await app.watcher.pollOnce();
    await flush();
    const sent = main().sent.filter((m) => m.document?.fileName === `${inv.name}.pdf`);
    expect(sent.map((m) => m.jid).sort()).toEqual([ACCOUNTS, '971527654321@s.whatsapp.net'].sort());
    const toSupplier = sent.find((m) => m.jid.endsWith('@s.whatsapp.net'))!;
    expect(toSupplier.document!.caption).toContain(`*${inv.bill_no}*`);
    expect(toSupplier.document!.data.subarray(0, 5).toString()).toBe('%PDF-');
    save('supplier-invoice-caption.txt', toSupplier.document!.caption ?? '');
  }, 120_000);

  it('does not send an invoice again after it is paid', async () => {
    const before = main().sent.length;
    await admin.receivePayment(acmeInvoice, 777);
    await app.watcher.pollOnce();
    await flush();
    expect(main().sent.length).toBe(before);
  }, 120_000);

  it("sends the branch company's invoices from the branch's own WhatsApp number", async () => {
    const mainBefore = main().sent.length;
    const inv = await admin.salesInvoice('Acme Trading', { qty: 1, rate: 300, company: BRANCH });
    await app.watcher.pollOnce();
    await flush();
    expect(branch().sent.filter((m) => m.document?.fileName === `${inv.name}.pdf`).map((m) => m.jid).sort()).toEqual(
      [BRANCH_GROUP, '971501234567@s.whatsapp.net'].sort(),
    );
    expect(main().sent.length).toBe(mainBefore);
  }, 120_000);

  it('redirects customer messages to the test recipient in test mode', async () => {
    const s = app.settings();
    s.general.testMode = true;
    s.general.testRecipient = '+971 50 000 0001';
    app.settingsStore.update(s);
    const inv = await admin.salesInvoice('Gamma Foods', { qty: 1, rate: 99 });
    await app.watcher.pollOnce();
    await flush();
    const sent = main().sent.filter((m) => m.document?.fileName === `${inv.name}.pdf`);
    expect(sent.map((m) => m.jid).sort()).toEqual([MGMT, '971500000001@s.whatsapp.net'].sort());
    expect(sent.find((m) => m.jid === '971500000001@s.whatsapp.net')!.document!.caption).toMatch(/TEST MODE\* – this would be sent to Gamma Foods \(\+971559876543\)/);
    s.general.testMode = false;
    app.settingsStore.update(s);
  }, 120_000);

  it('receives ERPNext webhooks (signed) and sends without waiting for the next check', async () => {
    const hook = await admin.insert<{ name: string }>({
      doctype: 'Webhook',
      name: `Auto SMS integration test ${Date.now()}`,
      webhook_doctype: 'Sales Invoice',
      webhook_docevent: 'on_submit',
      request_url: `http://${WEBHOOK_HOST}:${PORT}/webhooks/erpnext`,
      request_method: 'POST',
      request_structure: 'JSON',
      webhook_json: '{"doctype": "{{ doc.doctype }}", "name": "{{ doc.name }}"}',
      enable_security: 1,
      webhook_secret: 'integration-webhook-secret',
      enabled: 1,
    });
    webhookName = hook.name;
    const inv = await admin.salesInvoice('Acme Trading', { qty: 1, rate: 15 });
    expect(await newInvoiceSent(inv.name)).toBe(true); // no pollOnce() here
    await flush();
    expect(main().sent.some((m) => m.document?.fileName === `${inv.name}.pdf` && m.jid === '971501234567@s.whatsapp.net')).toBe(true);

    // A forged call is refused.
    const forged = await fetch(`http://127.0.0.1:${PORT}/webhooks/erpnext`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Frappe-Webhook-Signature': 'bm9wZQ==' },
      body: JSON.stringify({ doctype: 'Sales Invoice', name: inv.name }),
    });
    expect(forged.status).toBe(401);
  }, 120_000);

  it('builds and sends every scheduled report from real ERPNext data', async () => {
    const texts: string[] = [];
    for (const report of app.settings().reports.items) {
      const result = await app.reports.run(report.id, 'manual');
      expect(result.note, `${report.id}: ${result.note}`).toBeUndefined();
      expect(result.groups).toEqual([MGMT]);
      expect(result.accountId).toBe('main');
      texts.push(result.text);
    }
    await flush();
    const [daily, receivables, payables, stock, cash] = texts;
    expect(daily).toMatch(/Daily Sales Summary/);
    expect(daily).toMatch(/Invoices: \*\d+\*/);
    expect(receivables).toMatch(/Gamma Foods/);
    expect(receivables).toMatch(/overdue AED/);
    expect(payables).toMatch(/Delta Supplies/);
    expect(stock).toMatch(/Widget A/);
    expect(stock).not.toMatch(/Widget B/);
    expect(cash).toMatch(/Emirates NBD: \*AED 50,000.00\*/);
    expect(main().sent.filter((m) => m.jid === MGMT && m.text).length).toBeGreaterThanOrEqual(5);
    save('reports.txt', texts.join('\n\n-----\n\n'));

    // The same report for the branch company goes out from the branch number.
    const branchDaily = await app.reports.run({ ...app.settings().reports.items[0], id: 'branch-daily', company: BRANCH }, 'manual');
    expect(branchDaily.accountId).toBe('branch');
    expect(branchDaily.groups).toEqual([BRANCH_GROUP]);
    expect(branchDaily.text).toContain(BRANCH);
    await flush();
    expect(branch().sent.some((m) => m.jid === BRANCH_GROUP && m.text?.includes('Daily Sales Summary'))).toBe(true);
  }, 300_000);

  it('serves the dashboard API', async () => {
    const base = `http://127.0.0.1:${PORT}`;
    expect((await fetch(`${base}/api/status`)).status).toBe(401);
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'integration-test-password' }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const get = (p: string): Promise<any> => fetch(`${base}${p}`, { headers: { cookie } }).then((r) => r.json());

    const status = await get('/api/status');
    expect(status.whatsapp.map((a: { id: string }) => a.id)).toEqual(['main', 'branch']);
    expect(status.erpnext.ok).toBe(true);

    const settings = await get('/api/settings');
    expect(settings.settings.erpnext.apiSecret).toBe('');
    expect(settings.locked).toEqual(['erpnext.url', 'erpnext.apiKey', 'erpnext.apiSecret']);

    const groups = await get('/api/whatsapp/groups');
    expect(groups.accounts.branch.groups.map((g: { name: string }) => g.name)).toEqual(['Branch team']);

    const preview = await fetch(`${base}/api/reports/preview`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'receivables' }) }).then((r) => r.json() as Promise<any>);
    expect(preview.text).toMatch(/Receivables/);

    const added = await fetch(`${base}/api/whatsapp/accounts`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Abu Dhabi shop' }) }).then((r) => r.json() as Promise<any>);
    expect(added.id).toBe('abu-dhabi-shop');
    expect(app.whatsapp.ids()).toContain('abu-dhabi-shop');
    const removed = await fetch(`${base}/api/whatsapp/accounts/abu-dhabi-shop`, { method: 'DELETE', headers: { cookie } });
    expect(removed.status).toBe(200);
    const inUse = await fetch(`${base}/api/whatsapp/accounts/branch`, { method: 'DELETE', headers: { cookie } }).then((r) => r.json() as Promise<any>);
    expect(inUse.error).toMatch(/used by: Demo Branch LLC/);
  }, 60_000);
});
