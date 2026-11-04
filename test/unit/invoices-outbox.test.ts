import { describe, expect, it } from 'vitest';
import { defaultSettings, type Settings } from '../../src/config/settings.js';
import { Database } from '../../src/db/database.js';
import { ContextResolver } from '../../src/erpnext/context.js';
import { InvoiceService } from '../../src/invoices/service.js';
import { InvoiceWatcher, minusMinutes } from '../../src/invoices/watcher.js';
import { Outbox } from '../../src/messaging/outbox.js';
import { silentLogger } from '../../src/util/logger.js';
import { addDays, todayInTz } from '../../src/util/time.js';
import { FakeWhatsApp } from '../../src/whatsapp/fake.js';
import { WhatsAppManager } from '../../src/whatsapp/manager.js';
import { FakeErp } from '../helpers.js';

const GROUP_MGMT = '120363000000000001@g.us';
const GROUP_ACCOUNTS = '120363000000000002@g.us';

async function setup(patch: (s: Settings) => void = () => undefined) {
  const erp = new FakeErp();
  const settings = defaultSettings();
  settings.general.defaultCountryCode = '971';
  settings.general.testMode = false;
  settings.general.timezone = 'Asia/Dubai';
  settings.companies[0].purchaseGroups = [GROUP_ACCOUNTS];
  patch(settings);
  const db = new Database(':memory:');
  const phones = new Map<string, FakeWhatsApp>();
  const manager = new WhatsAppManager((id) => {
    const phone = new FakeWhatsApp();
    phones.set(id, phone);
    return phone;
  }, silentLogger);
  await manager.sync(settings.whatsapp.accounts);
  const outbox = new Outbox({ db, whatsapp: manager, logger: silentLogger, delayMs: () => 0, countryCode: () => settings.general.defaultCountryCode });
  const service = new InvoiceService({ db, outbox, erp: () => erp.asClient(), settings: () => settings, logger: silentLogger });
  const context = new ContextResolver(() => erp.asClient(), () => settings);
  const watcher = new InvoiceWatcher({ db, service, erp: () => erp.asClient(), settings: () => settings, context, logger: silentLogger });
  const today = todayInTz('Asia/Dubai');

  erp.add('Customer', { name: 'Acme Trading', customer_name: 'Acme Trading', mobile_no: '+971 50 123 4567' });
  erp.add('Customer', { name: 'Gamma Foods', customer_name: 'Gamma Foods', mobile_no: '' });
  erp.add('Customer', { name: 'Beta Stores', customer_name: 'Beta Stores', mobile_no: '' });
  erp.add('Contact', { name: 'Gamma Contact', mobile_no: '0559876543', is_primary_contact: 1, links: [{ link_doctype: 'Customer', link_name: 'Gamma Foods' }] });
  erp.add('Supplier', { name: 'Delta Supplies', supplier_name: 'Delta Supplies', mobile_no: '+971 52 765 4321' });

  const salesInvoice = (name: string, customer: string, extra: Record<string, unknown> = {}) =>
    erp.add('Sales Invoice', {
      name,
      customer,
      customer_name: customer,
      company: 'Demo Co',
      docstatus: 1,
      posting_date: today,
      due_date: addDays(today, 10),
      currency: 'AED',
      grand_total: 1500,
      rounded_total: 1500,
      outstanding_amount: 1500,
      is_return: 0,
      ...extra,
    });

  async function flush() {
    for (let m = db.nextQueuedMessage(); m; m = db.nextQueuedMessage()) await outbox.deliver(m);
  }

  return { erp, settings, db, phones, wa: phones.get('main')!, manager, outbox, service, watcher, today, salesInvoice, flush };
}

describe('InvoiceService', () => {
  it('sends the PDF with a personal message to the customer', async () => {
    const t = await setup();
    t.salesInvoice('SINV-1', 'Acme Trading');
    const result = await t.service.process('Sales Invoice', 'SINV-1', { source: 'poll' });
    expect(result.status).toBe('queued');
    await t.flush();
    expect(t.wa.sent).toHaveLength(1);
    const msg = t.wa.sent[0];
    expect(msg.jid).toBe('971501234567@s.whatsapp.net');
    expect(msg.document?.fileName).toBe('SINV-1.pdf');
    expect(msg.document?.data.toString()).toContain('%PDF');
    expect(msg.document?.caption).toContain('Dear Acme Trading');
    expect(msg.document?.caption).toContain('*SINV-1*');
    expect(msg.document?.caption).toContain('AED 1,500.00');
    expect(t.db.messageCounts().sent).toBe(1);
  });

  it('finds the number on a linked contact and adds the country code to local numbers', async () => {
    const t = await setup();
    t.salesInvoice('SINV-2', 'Gamma Foods');
    await t.service.process('Sales Invoice', 'SINV-2', { source: 'poll' });
    await t.flush();
    expect(t.wa.sent[0].jid).toBe('971559876543@s.whatsapp.net');
  });

  it('records a clear failure when the customer has no number', async () => {
    const t = await setup((s) => (s.companies[0].salesGroups = [GROUP_MGMT]));
    t.salesInvoice('SINV-3', 'Beta Stores');
    await t.service.process('Sales Invoice', 'SINV-3', { source: 'poll' });
    await t.flush();
    const messages = t.db.messagesForDoc('Sales Invoice', 'SINV-3');
    const party = messages.find((m) => m.audience === 'party')!;
    expect(party.status).toBe('failed');
    expect(party.error).toMatch(/Beta Stores has no mobile number/);
    // the internal group still gets its copy, which mentions the problem
    expect(t.wa.sent).toHaveLength(1);
    expect(t.wa.sent[0].document?.caption).toMatch(/Not sent to the customer/);
  });

  it('redirects customer messages to the test recipient in test mode', async () => {
    const t = await setup((s) => {
      s.general.testMode = true;
      s.general.testRecipient = '+971 50 000 0001';
    });
    t.salesInvoice('SINV-4', 'Acme Trading');
    await t.service.process('Sales Invoice', 'SINV-4', { source: 'poll' });
    await t.flush();
    expect(t.wa.sent).toHaveLength(1);
    expect(t.wa.sent[0].jid).toBe('971500000001@s.whatsapp.net');
    expect(t.wa.sent[0].document?.caption).toMatch(/TEST MODE.*Acme Trading \(\+971501234567\)/);
  });

  it('only logs customer messages in test mode without a test recipient', async () => {
    const t = await setup((s) => (s.general.testMode = true));
    t.salesInvoice('SINV-5', 'Acme Trading');
    await t.service.process('Sales Invoice', 'SINV-5', { source: 'poll' });
    await t.flush();
    expect(t.wa.sent).toHaveLength(0);
    expect(t.db.messagesForDoc('Sales Invoice', 'SINV-5')[0].status).toBe('skipped');
  });

  it('sends supplier invoices to the supplier and the accounts group', async () => {
    const t = await setup();
    t.erp.add('Purchase Invoice', { name: 'PINV-1', supplier: 'Delta Supplies', supplier_name: 'Delta Supplies', company: 'Demo Co', docstatus: 1, posting_date: t.today, bill_no: 'DS-7781', bill_date: t.today, currency: 'AED', grand_total: 3000, outstanding_amount: 3000, is_return: 0 });
    await t.service.process('Purchase Invoice', 'PINV-1', { source: 'poll' });
    await t.flush();
    const jids = t.wa.sent.map((m) => m.jid).sort();
    expect(jids).toEqual([GROUP_ACCOUNTS, '971527654321@s.whatsapp.net'].sort());
    const supplierMsg = t.wa.sent.find((m) => m.jid.endsWith('@s.whatsapp.net'))!;
    expect(supplierMsg.document?.caption).toContain('recorded your invoice *DS-7781*');
    const groupMsg = t.wa.sent.find((m) => m.jid === GROUP_ACCOUNTS)!;
    expect(groupMsg.document?.caption).toMatch(/New Purchase Invoice\* PINV-1/);
    expect(groupMsg.document?.caption).toMatch(/Sent to the supplier on \+971527654321/);
    expect(t.erp.pdfCalls).toHaveLength(1); // one PDF shared by both messages
  });

  it('never sends the same invoice twice, but allows a manual resend', async () => {
    const t = await setup();
    t.salesInvoice('SINV-6', 'Acme Trading');
    await t.service.process('Sales Invoice', 'SINV-6', { source: 'poll' });
    const again = await t.service.process('Sales Invoice', 'SINV-6', { source: 'webhook' });
    expect(again.status).toBe('already_done');
    await t.service.process('Sales Invoice', 'SINV-6', { source: 'manual', force: true, only: ['party'] });
    await t.flush();
    expect(t.wa.sent).toHaveLength(2);
  });

  it('skips drafts, returns (when switched off) and disabled types', async () => {
    const t = await setup((s) => (s.invoices.sales.includeReturns = false));
    t.salesInvoice('SINV-D', 'Acme Trading', { docstatus: 0 });
    t.salesInvoice('SINV-R', 'Acme Trading', { is_return: 1, grand_total: -500 });
    expect((await t.service.process('Sales Invoice', 'SINV-D', { source: 'webhook' })).detail).toMatch(/not submitted/);
    expect((await t.service.process('Sales Invoice', 'SINV-R', { source: 'poll' })).detail).toMatch(/returns are not sent/);
    t.settings.invoices.sales.enabled = false;
    t.salesInvoice('SINV-X', 'Acme Trading');
    expect((await t.service.process('Sales Invoice', 'SINV-X', { source: 'poll' })).status).toBe('skipped');
  });

  it('labels credit notes', async () => {
    const t = await setup();
    const vars = t.service.buildTemplateVars('Sales Invoice', { name: 'SINV-R', is_return: 1, currency: 'AED', grand_total: -500, customer_name: 'Acme' });
    expect(vars.doc_title).toBe('Credit Note');
    expect(vars.doc_label).toBe('credit note');
    expect(vars.grand_total).toBe('AED -500.00');
  });

  it('retries later when ERPNext fails temporarily', async () => {
    const t = await setup();
    t.erp.failPdf = 1;
    t.salesInvoice('SINV-7', 'Acme Trading');
    await expect(t.service.process('Sales Invoice', 'SINV-7', { source: 'poll' })).rejects.toThrow(/PDF/);
    expect(t.db.getProcessed('Sales Invoice', 'SINV-7')?.status).toBe('retry');
    const result = await t.service.process('Sales Invoice', 'SINV-7', { source: 'poll' });
    expect(result.status).toBe('queued');
  });
});

describe('several WhatsApp numbers – one per company', () => {
  const twoCompanies = (s: Settings) => {
    s.whatsapp.accounts = [
      { id: 'main', label: 'Head office' },
      { id: 'branch', label: 'Branch' },
    ];
    s.companies = [
      { company: 'Demo Co', accountId: 'main', salesGroups: [GROUP_MGMT], purchaseGroups: [], reportGroups: [] },
      { company: 'Branch Co', accountId: 'branch', salesGroups: [GROUP_ACCOUNTS], purchaseGroups: [], reportGroups: [] },
    ];
  };

  it('sends each company’s invoices from its own number to its own groups', async () => {
    const t = await setup(twoCompanies);
    t.salesInvoice('HQ-1', 'Acme Trading');
    t.salesInvoice('BR-1', 'Gamma Foods', { company: 'Branch Co' });
    await t.service.process('Sales Invoice', 'HQ-1', { source: 'poll' });
    await t.service.process('Sales Invoice', 'BR-1', { source: 'poll' });
    await t.flush();
    const main = t.phones.get('main')!.sent.map((m) => `${m.document?.fileName}→${m.jid}`).sort();
    const branch = t.phones.get('branch')!.sent.map((m) => `${m.document?.fileName}→${m.jid}`).sort();
    expect(main).toEqual(['HQ-1.pdf→120363000000000001@g.us', 'HQ-1.pdf→971501234567@s.whatsapp.net']);
    expect(branch).toEqual(['BR-1.pdf→120363000000000002@g.us', 'BR-1.pdf→971559876543@s.whatsapp.net']);
  });

  it('skips companies without a number when there is no catch-all entry', async () => {
    const t = await setup(twoCompanies);
    t.salesInvoice('OTHER-1', 'Acme Trading', { company: 'Third Co' });
    const result = await t.service.process('Sales Invoice', 'OTHER-1', { source: 'poll' });
    expect(result.status).toBe('skipped');
    expect(result.detail).toMatch(/no WhatsApp number is set up for company "Third Co"/);
  });

  it('keeps messages waiting while one number is offline, without blocking the other', async () => {
    const t = await setup(twoCompanies);
    await t.phones.get('branch')!.stop();
    t.salesInvoice('HQ-2', 'Acme Trading', { company: 'Demo Co' });
    t.salesInvoice('BR-2', 'Gamma Foods', { company: 'Branch Co' });
    await t.service.process('Sales Invoice', 'HQ-2', { source: 'poll' });
    await t.service.process('Sales Invoice', 'BR-2', { source: 'poll' });
    for (let m = t.db.nextQueuedMessage('main'); m; m = t.db.nextQueuedMessage('main')) await t.outbox.deliver(m);
    expect(t.phones.get('main')!.sent).toHaveLength(2);
    expect(t.db.nextQueuedMessage('branch')).not.toBeNull();
  });

  it('fails the waiting messages of a removed number', async () => {
    const t = await setup(twoCompanies);
    t.outbox.start();
    t.outbox.enqueue({ accountId: 'branch', kind: 'test', audience: 'direct', recipient: '971501234567', body: 'x' });
    await t.manager.sync([{ id: 'main', label: 'Head office' }]);
    expect(t.db.listMessages({ status: 'failed' }).rows[0].error).toMatch(/number was removed/);
    await t.outbox.stop();
  });
});

describe('InvoiceWatcher', () => {
  it('ignores existing invoices, sends new ones, and ignores later edits/payments', async () => {
    const t = await setup();
    t.salesInvoice('OLD-1', 'Acme Trading');
    await t.watcher.pollOnce(); // first run: remembers the starting point only
    await t.flush();
    expect(t.wa.sent).toHaveLength(0);

    t.salesInvoice('NEW-1', 'Acme Trading');
    t.erp.add('Sales Invoice', { name: 'DRAFT-1', customer: 'Acme Trading', company: 'Demo Co', docstatus: 0, posting_date: t.today });
    await t.watcher.pollOnce();
    await t.flush();
    expect(t.wa.sent.map((m) => m.document?.fileName)).toEqual(['NEW-1.pdf']);

    // A payment touches both the old and the new invoice: nothing is sent again.
    t.erp.touch('Sales Invoice', 'OLD-1', { outstanding_amount: 0 });
    t.erp.touch('Sales Invoice', 'NEW-1', { outstanding_amount: 0 });
    await t.watcher.pollOnce();
    await t.flush();
    expect(t.wa.sent).toHaveLength(1);

    // Submitting the draft later sends it.
    t.erp.touch('Sales Invoice', 'DRAFT-1', { docstatus: 1, customer_name: 'Acme Trading', currency: 'AED', grand_total: 10, outstanding_amount: 10, is_return: 0 });
    await t.watcher.pollOnce();
    await t.flush();
    expect(t.wa.sent.map((m) => m.document?.fileName)).toEqual(['NEW-1.pdf', 'DRAFT-1.pdf']);
  });

  it('does not auto-send back-dated invoices older than maxAgeDays', async () => {
    const t = await setup((s) => (s.invoices.maxAgeDays = 3));
    await t.watcher.pollOnce();
    t.salesInvoice('BACKDATED', 'Acme Trading', { posting_date: addDays(t.today, -10) });
    await t.watcher.pollOnce();
    await t.flush();
    expect(t.wa.sent).toHaveLength(0);
  });

  it('subtracts the overlap window from ERPNext timestamps', () => {
    expect(minusMinutes('2026-11-04 00:05:00.123456', 10)).toBe('2026-11-03 23:55:00');
  });
});

describe('Outbox', () => {
  it('retries temporary failures with back-off', async () => {
    const t = await setup();
    t.wa.failNextSends = 1;
    const id = t.outbox.enqueue({ accountId: 'main', kind: 'test', audience: 'direct', recipient: '971501234567', body: 'hello' })!;
    await t.outbox.deliver(t.db.nextQueuedMessage()!);
    const row = t.db.getMessage(id)!;
    expect(row.status).toBe('queued');
    expect(row.error).toMatch(/Simulated/);
    expect(new Date(row.next_attempt_at!).getTime()).toBeGreaterThan(Date.now());
    expect(t.db.nextQueuedMessage()).toBeNull(); // not due yet
  });

  it('fails permanently for numbers without WhatsApp and unknown groups', async () => {
    const t = await setup();
    t.wa.numbersWithoutWhatsApp.add('971509999999');
    const a = t.outbox.enqueue({ accountId: 'main', kind: 'test', audience: 'direct', recipient: '971509999999', body: 'x' })!;
    const b = t.outbox.enqueue({ accountId: 'main', kind: 'test', audience: 'group', recipient: '999@g.us', body: 'x' })!;
    await t.flush();
    expect(t.db.getMessage(a)!.error).toMatch(/does not have a WhatsApp account/);
    expect(t.db.getMessage(b)!.status).toBe('failed');
    expect(t.outbox.retry(a)).toBe(true);
    expect(t.db.getMessage(a)!.status).toBe('queued');
  });

  it('expires messages that waited more than 3 days', async () => {
    const t = await setup();
    const id = t.outbox.enqueue({ accountId: 'main', kind: 'test', audience: 'direct', recipient: '971501234567', body: 'old' })!;
    t.db.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 4 * 86_400_000).toISOString(), id);
    await t.flush();
    expect(t.db.getMessage(id)!.error).toMatch(/Expired/);
    expect(t.wa.sent).toHaveLength(0);
  });

  it('deduplicates by key', async () => {
    const t = await setup();
    expect(t.outbox.enqueue({ accountId: 'main', kind: 'test', audience: 'direct', recipient: '1', body: 'x', dedupeKey: 'k' })).not.toBeNull();
    expect(t.outbox.enqueue({ accountId: 'main', kind: 'test', audience: 'direct', recipient: '1', body: 'x', dedupeKey: 'k' })).toBeNull();
  });

  it('sends through the background workers once started', async () => {
    const t = await setup();
    t.outbox.start();
    t.outbox.enqueue({ accountId: 'main', kind: 'test', audience: 'direct', recipient: '971501234567', body: 'via worker' });
    const deadline = Date.now() + 3000;
    while (!t.wa.sent.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await t.outbox.stop();
    expect(t.wa.sent[0]?.text).toBe('via worker');
  });
});
