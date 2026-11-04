/**
 * Turns a submitted Sales Invoice / Purchase Invoice into WhatsApp messages:
 *  - the PDF + a personal message to the customer / supplier
 *  - an internal summary (with the PDF) to the selected groups
 */
import type { Database } from '../db/database.js';
import { ErpNextError, type ErpNextClient } from '../erpnext/client.js';
import { findPartyPhone, type PartyType } from '../erpnext/contacts.js';
import type { Outbox } from '../messaging/outbox.js';
import type { InvoiceSettings, Settings } from '../config/settings.js';
import { formatMoney, safeFileName, toNumber } from '../util/format.js';
import type { Logger } from '../util/logger.js';
import { displayPhone, isGroupJid, isJid, normalizePhone } from '../util/phone.js';
import { renderTemplate } from '../util/template.js';
import { formatDate } from '../util/time.js';

export const INVOICE_DOCTYPES = ['Sales Invoice', 'Purchase Invoice'] as const;
export type InvoiceDoctype = (typeof INVOICE_DOCTYPES)[number];

export function isInvoiceDoctype(value: unknown): value is InvoiceDoctype {
  return INVOICE_DOCTYPES.includes(value as InvoiceDoctype);
}

export interface ProcessOptions {
  /** poll = found by the watcher, webhook = ERPNext called us, manual = dashboard button */
  source: 'poll' | 'webhook' | 'manual';
  /** Send again even if this invoice was already handled (manual resend). */
  force?: boolean;
  /** Only these audiences (manual resend of one part). */
  only?: Array<'party' | 'group'>;
}

export interface ProcessResult {
  status: 'queued' | 'skipped' | 'already_done';
  detail: string;
  messageIds: number[];
}

type Doc = Record<string, unknown>;

interface Meta {
  partyType: PartyType;
  partyField: string;
  partyNameField: string;
  settings: InvoiceSettings;
}

export class InvoiceService {
  private readonly log: Logger;

  constructor(
    private readonly deps: {
      db: Database;
      outbox: Outbox;
      erp: () => ErpNextClient;
      settings: () => Settings;
      logger: Logger;
    },
  ) {
    this.log = deps.logger.child({ scope: 'invoices' });
  }

  private meta(doctype: InvoiceDoctype): Meta {
    const settings = this.deps.settings();
    return doctype === 'Sales Invoice'
      ? { partyType: 'Customer', partyField: 'customer', partyNameField: 'customer_name', settings: settings.invoices.sales }
      : { partyType: 'Supplier', partyField: 'supplier', partyNameField: 'supplier_name', settings: settings.invoices.purchase };
  }

  /** Values available in message templates. */
  buildTemplateVars(doctype: InvoiceDoctype, doc: Doc, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const settings = this.deps.settings();
    const { partyField, partyNameField } = this.meta(doctype);
    const fmt = settings.general.dateFormat;
    const locale = settings.general.numberLocale;
    const currency = String(doc.currency ?? '');
    const partyCurrency = String(doc.party_account_currency || currency);
    const isReturn = toNumber(doc.is_return) === 1;
    const docTitle = isReturn ? (doctype === 'Sales Invoice' ? 'Credit Note' : 'Debit Note') : doctype;
    const money = (value: unknown, cur = currency) => (value === undefined || value === null || value === '' ? '' : formatMoney(value, cur, locale));
    const grandTotal = toNumber(doc.rounded_total) || toNumber(doc.grand_total);
    return {
      doc,
      name: doc.name,
      doctype,
      doc_title: docTitle,
      doc_label: docTitle === doctype ? 'invoice' : docTitle.toLowerCase(),
      party: doc[partyField],
      party_name: doc[partyNameField] || doc[partyField],
      company: doc.company,
      posting_date: formatDate(doc.posting_date as string, fmt),
      due_date: formatDate(doc.due_date as string, fmt),
      bill_no: doc.bill_no ?? '',
      bill_date: formatDate(doc.bill_date as string, fmt),
      po_no: doc.po_no ?? '',
      currency,
      grand_total: money(grandTotal),
      net_total: money(doc.net_total),
      total_taxes: money(doc.total_taxes_and_charges),
      outstanding_amount: money(doc.outstanding_amount, partyCurrency),
      paid_amount: money(grandTotal - toNumber(doc.outstanding_amount)),
      status: doc.status,
      ...extra,
    };
  }

  /** Handles one invoice. Never throws for "expected" situations; returns what happened. */
  async process(doctype: InvoiceDoctype, name: string, options: ProcessOptions): Promise<ProcessResult> {
    const { db } = this.deps;
    const previous = db.getProcessed(doctype, name);
    if (!options.force && previous && previous.status !== 'retry') {
      return { status: 'already_done', detail: previous.detail ?? previous.status, messageIds: [] };
    }

    try {
      const result = await this.build(doctype, name, options);
      db.setProcessed(doctype, name, result.status === 'queued' ? 'done' : 'skipped', result.detail);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanent = error instanceof ErpNextError && error.permanent;
      const attempts = (previous?.attempts ?? 0) + 1;
      if (options.source === 'manual') throw error;
      if (permanent || attempts >= 5) {
        db.setProcessed(doctype, name, 'failed', message, attempts);
        this.log.error(`${doctype} ${name}: giving up – ${message}`);
      } else {
        db.setProcessed(doctype, name, 'retry', message, attempts);
        this.log.warn(`${doctype} ${name}: will retry (${attempts}/5) – ${message}`);
      }
      throw error;
    }
  }

  private async build(doctype: InvoiceDoctype, name: string, options: ProcessOptions): Promise<ProcessResult> {
    const erp = this.deps.erp();
    const settings = this.deps.settings();
    const meta = this.meta(doctype);
    const cfg = meta.settings;

    if (!cfg.enabled && options.source !== 'manual') {
      return { status: 'skipped', detail: `${doctype} sending is turned off`, messageIds: [] };
    }

    const doc = await erp.getDoc<Doc>(doctype, name);
    if (toNumber(doc.docstatus) !== 1) {
      return { status: 'skipped', detail: `not submitted (docstatus ${doc.docstatus})`, messageIds: [] };
    }
    if (toNumber(doc.is_return) === 1 && !cfg.includeReturns && options.source !== 'manual') {
      return { status: 'skipped', detail: 'returns are not sent (setting)', messageIds: [] };
    }
    if (settings.general.company && doc.company !== settings.general.company && options.source !== 'manual') {
      return { status: 'skipped', detail: `belongs to another company (${doc.company})`, messageIds: [] };
    }

    const wantParty = cfg.sendToParty && (!options.only || options.only.includes('party'));
    const groups = !options.only || options.only.includes('group') ? cfg.groups.filter(Boolean) : [];
    if (!wantParty && groups.length === 0) {
      return { status: 'skipped', detail: 'no recipients configured', messageIds: [] };
    }

    const partyId = String(doc[meta.partyField] ?? '');
    const partyName = String(doc[meta.partyNameField] || partyId);

    // Who is the customer/supplier on WhatsApp?
    let partyDigits: string | null = null;
    let partyProblem = '';
    if (wantParty) {
      const found = await findPartyPhone(erp, meta.partyType, partyId, doc, settings.invoices.whatsappField);
      if (!found) partyProblem = `${meta.partyType} ${partyName} has no mobile number in ERPNext`;
      else {
        partyDigits = normalizePhone(found.raw, settings.general.defaultCountryCode);
        if (!partyDigits) {
          partyProblem = `the number "${found.raw}" (${found.source}) can't be used${found.raw.trim().startsWith('0') && !settings.general.defaultCountryCode ? ' – set the default country code in Settings' : ''}`;
        }
      }
    }

    const testMode = settings.general.testMode;
    let partyDelivery = '';
    if (wantParty) {
      if (partyProblem) partyDelivery = `⚠️ Not sent to the ${meta.partyType.toLowerCase()}: ${partyProblem}`;
      else if (testMode) partyDelivery = `🧪 Test mode – not sent to the ${meta.partyType.toLowerCase()} (${displayPhone(partyDigits!)})`;
      else partyDelivery = `Sent to the ${meta.partyType.toLowerCase()} on ${displayPhone(partyDigits!)}`;
    }

    // The PDF (fetched once, shared by all messages of this invoice).
    let attachmentId: number | null = null;
    let attachmentName: string | null = null;
    if (cfg.attachPdf) {
      const pdf = await erp.downloadPdf(doctype, name, { printFormat: cfg.printFormat, letterhead: cfg.letterhead, pdfGenerator: settings.invoices.pdfGenerator });
      attachmentName = `${safeFileName(name)}.pdf`;
      attachmentId = this.deps.db.addAttachment(attachmentName, 'application/pdf', pdf);
    }

    const vars = this.buildTemplateVars(doctype, doc, { party_delivery: partyDelivery });
    const ids: number[] = [];
    const stamp = options.force ? `:${Date.now()}` : '';
    const ref = { kind: 'invoice' as const, refDoctype: doctype, refName: name, attachmentId, attachmentName };

    if (wantParty) {
      const body = renderTemplate(cfg.partyMessage, vars);
      const dedupeKey = `inv:${doctype}:${name}:party${stamp}`;
      if (partyProblem) {
        const id = this.deps.outbox.enqueue({ ...ref, audience: 'party', recipient: '-', recipientName: partyName, body, status: 'failed', error: partyProblem, dedupeKey });
        if (id) ids.push(id);
      } else if (testMode) {
        const target = this.testTarget();
        const header = `🧪 *TEST MODE* – this would be sent to ${partyName} (${displayPhone(partyDigits!)})\n\n`;
        const id = this.deps.outbox.enqueue({
          ...ref,
          audience: 'test',
          recipient: target ?? '-',
          recipientName: target ? `Test recipient (instead of ${partyName})` : partyName,
          body: header + body,
          status: target ? 'queued' : 'skipped',
          error: target ? null : 'Test mode is on and no test recipient is set – message was only logged',
          dedupeKey,
        });
        if (id) ids.push(id);
      } else {
        const id = this.deps.outbox.enqueue({ ...ref, audience: 'party', recipient: partyDigits!, recipientName: partyName, body, dedupeKey });
        if (id) ids.push(id);
      }
    }

    if (groups.length) {
      const body = renderTemplate(cfg.groupMessage, vars);
      for (const jid of groups) {
        const id = this.deps.outbox.enqueue({ ...ref, audience: 'group', recipient: jid, recipientName: null, body, dedupeKey: `inv:${doctype}:${name}:group:${jid}${stamp}` });
        if (id) ids.push(id);
      }
    }

    const detail = [wantParty ? partyDelivery.replace(/^\W+\s*/, '') : '', groups.length ? `${groups.length} group(s)` : ''].filter(Boolean).join('; ');
    this.log.info(`${doctype} ${name} (${partyName}) → ${detail || 'nothing to send'}`);
    return { status: 'queued', detail, messageIds: ids };
  }

  /** Normalised test recipient (phone digits or group JID) or null when not set. */
  private testTarget(): string | null {
    const settings = this.deps.settings();
    const raw = settings.general.testRecipient.trim();
    if (!raw) return null;
    if (isJid(raw) || isGroupJid(raw)) return raw;
    return normalizePhone(raw, settings.general.defaultCountryCode);
  }
}
