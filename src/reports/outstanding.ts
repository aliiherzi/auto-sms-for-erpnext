/** Receivables (customers who owe you) and payables (what you owe suppliers), from unpaid invoices. */
import type { ReportConfig } from '../config/settings.js';
import { toNumber, truncate } from '../util/format.js';
import { daysBetween } from '../util/time.js';
import { outstandingInCompanyCurrency } from './daily-sales.js';
import type { ReportBuilder } from './types.js';

type OutstandingConfig = Extract<ReportConfig, { type: 'receivables' | 'payables' }>;

interface Row {
  name: string;
  party: string;
  party_name: string;
  outstanding_amount: number;
  due_date: string | null;
  posting_date: string;
  currency: string;
  conversion_rate: number;
  party_account_currency: string;
}

interface PartyTotal {
  name: string;
  total: number;
  overdue: number;
  invoices: number;
  overdueInvoices: number;
  oldestDue: string | null;
}

export const outstanding: ReportBuilder<OutstandingConfig> = async (config, ctx) => {
  const { erp, company, fmt, today } = ctx;
  const receivable = config.type === 'receivables';
  const doctype = receivable ? 'Sales Invoice' : 'Purchase Invoice';
  const partyField = receivable ? 'customer' : 'supplier';
  const nameField = receivable ? 'customer_name' : 'supplier_name';

  const raw = await erp.getAll<Record<string, unknown>>(doctype, {
    fields: ['name', partyField, nameField, 'outstanding_amount', 'due_date', 'posting_date', 'currency', 'conversion_rate', 'party_account_currency'],
    filters: [
      ['docstatus', '=', 1],
      ['company', '=', company],
      ['outstanding_amount', '!=', 0],
    ],
  });
  const rows: Row[] = raw.map((r) => ({
    name: String(r.name),
    party: String(r[partyField] ?? ''),
    party_name: String(r[nameField] || r[partyField] || ''),
    outstanding_amount: toNumber(r.outstanding_amount),
    due_date: (r.due_date as string) || null,
    posting_date: String(r.posting_date ?? ''),
    currency: String(r.currency ?? ''),
    conversion_rate: toNumber(r.conversion_rate),
    party_account_currency: String(r.party_account_currency ?? ''),
  }));

  const parties = new Map<string, PartyTotal>();
  let total = 0;
  let overdue = 0;
  let overdueCount = 0;
  for (const row of rows) {
    const amount = outstandingInCompanyCurrency(row, ctx.currency);
    const isOverdue = amount > 0 && Boolean(row.due_date) && row.due_date! < today;
    const entry = parties.get(row.party) ?? { name: row.party_name, total: 0, overdue: 0, invoices: 0, overdueInvoices: 0, oldestDue: null };
    entry.total += amount;
    entry.invoices += 1;
    if (isOverdue) {
      entry.overdue += amount;
      entry.overdueInvoices += 1;
      if (!entry.oldestDue || row.due_date! < entry.oldestDue) entry.oldestDue = row.due_date;
      overdue += amount;
      overdueCount += 1;
    }
    total += amount;
    parties.set(row.party, entry);
  }

  const icon = receivable ? '💰' : '📤';
  const heading = config.title || (receivable ? 'Receivables' : 'Payables');
  const subtitle = receivable ? 'money customers owe you' : 'what you owe suppliers';
  const lines: string[] = [`${icon} *${heading}* – ${subtitle}`, `*${company}* · ${fmt.day(today)}`, ''];

  const owing = [...parties.values()].filter((p) => p.total > 0.0001);
  if (!owing.length) {
    lines.push(receivable ? '✅ No unpaid sales invoices.' : '✅ No unpaid purchase invoices.');
    return { text: lines.join('\n'), empty: true };
  }

  const invoiceCount = owing.reduce((n, p) => n + p.invoices, 0);
  lines.push(`${receivable ? 'Total outstanding' : 'Total to pay'}: *${fmt.money(total)}* (${invoiceCount} invoice${invoiceCount === 1 ? '' : 's'})`);
  lines.push(`Overdue: *${fmt.money(overdue)}* (${overdueCount} invoice${overdueCount === 1 ? '' : 's'})`);

  const list = owing
    .filter((p) => !config.options.onlyOverdue || p.overdue > 0)
    .sort((a, b) => b.overdue - a.overdue || b.total - a.total)
    .slice(0, config.options.topParties);

  if (list.length) {
    lines.push('');
    lines.push(`*${config.options.onlyOverdue ? 'Overdue' : 'Top'} ${list.length} ${receivable ? 'customer' : 'supplier'}${list.length === 1 ? '' : 's'}*`);
    list.forEach((p, i) => {
      lines.push(`${i + 1}. *${truncate(p.name, 40)}* – ${fmt.money(p.total)}`);
      if (p.overdue > 0) {
        const days = p.oldestDue ? daysBetween(p.oldestDue, today) : 0;
        lines.push(`    overdue ${fmt.money(p.overdue)} · oldest ${days} day${days === 1 ? '' : 's'}`);
      } else {
        lines.push('    not due yet');
      }
    });
    const rest = owing.length - list.length;
    if (rest > 0 && !config.options.onlyOverdue) lines.push(`…and ${rest} more`);
  }

  return { text: lines.join('\n'), empty: false };
};
