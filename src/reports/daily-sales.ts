/** Daily sales summary: invoices, returns, paid vs unpaid, payments received, month to date, top customers. */
import type { ReportConfig } from '../config/settings.js';
import { toNumber, truncate } from '../util/format.js';
import { addDays, monthLabel, monthStart } from '../util/time.js';
import type { ReportBuilder } from './types.js';

type DailySalesConfig = Extract<ReportConfig, { type: 'daily_sales' }>;

interface InvoiceRow {
  name: string;
  customer: string;
  customer_name: string;
  base_grand_total: number;
  base_rounded_total: number;
  outstanding_amount: number;
  is_return: number;
  currency: string;
  conversion_rate: number;
  party_account_currency: string;
}

/** Outstanding amount converted to company currency. */
export function outstandingInCompanyCurrency(
  row: { outstanding_amount: unknown; party_account_currency?: unknown; currency?: unknown; conversion_rate?: unknown },
  companyCurrency: string,
): number {
  const amount = toNumber(row.outstanding_amount);
  const partyCurrency = String(row.party_account_currency || row.currency || '');
  if (!partyCurrency || !companyCurrency || partyCurrency === companyCurrency) return amount;
  return amount * (toNumber(row.conversion_rate) || 1);
}

export const dailySales: ReportBuilder<DailySalesConfig> = async (config, ctx) => {
  const { erp, company, fmt } = ctx;
  const day = config.options.day === 'yesterday' ? addDays(ctx.today, -1) : ctx.today;

  const invoices = await erp.getAll<InvoiceRow>('Sales Invoice', {
    fields: ['name', 'customer', 'customer_name', 'base_grand_total', 'base_rounded_total', 'outstanding_amount', 'is_return', 'currency', 'conversion_rate', 'party_account_currency'],
    filters: [
      ['docstatus', '=', 1],
      ['company', '=', company],
      ['posting_date', '=', day],
    ],
  });

  const amountOf = (row: InvoiceRow) => toNumber(row.base_rounded_total) || toNumber(row.base_grand_total);
  const sales = invoices.filter((r) => !toNumber(r.is_return));
  const returns = invoices.filter((r) => toNumber(r.is_return));
  const salesTotal = sales.reduce((sum, r) => sum + amountOf(r), 0);
  const returnsTotal = returns.reduce((sum, r) => sum + amountOf(r), 0);
  const unpaid = sales.reduce((sum, r) => sum + Math.max(0, outstandingInCompanyCurrency(r, ctx.currency)), 0);
  const paid = Math.max(0, salesTotal - unpaid);

  const lines: string[] = [];
  lines.push(`📊 *${config.title || 'Daily Sales Summary'}*`);
  lines.push(`*${company}* · ${fmt.day(day)}`);
  lines.push('');

  if (!invoices.length) {
    lines.push('No sales invoices were submitted on this day.');
  } else {
    lines.push(`🧾 Invoices: *${sales.length}* · *${fmt.money(salesTotal)}*`);
    if (returns.length) {
      lines.push(`↩️ Returns: ${returns.length} · ${fmt.money(returnsTotal)}`);
      lines.push(`💵 Net sales: *${fmt.money(salesTotal + returnsTotal)}*`);
    }
    lines.push(`✅ Paid: ${fmt.money(paid)}`);
    lines.push(`⏳ Unpaid: ${fmt.money(unpaid)}`);
  }

  if (config.options.includePayments) {
    const payments = await erp.getAll<{ base_received_amount: number }>('Payment Entry', {
      fields: ['name', 'base_received_amount'],
      filters: [
        ['docstatus', '=', 1],
        ['company', '=', company],
        ['payment_type', '=', 'Receive'],
        ['posting_date', '=', day],
      ],
    });
    const received = payments.reduce((sum, p) => sum + toNumber(p.base_received_amount), 0);
    lines.push(`💰 Payments received: *${fmt.money(received)}*${payments.length ? ` (${payments.length})` : ''}`);
  }

  if (config.options.includeMonthToDate) {
    const mtd = await erp.getAll<{ base_grand_total: number; base_rounded_total: number }>('Sales Invoice', {
      fields: ['base_grand_total', 'base_rounded_total'],
      filters: [
        ['docstatus', '=', 1],
        ['company', '=', company],
        ['posting_date', '>=', monthStart(day)],
        ['posting_date', '<=', day],
      ],
    });
    const total = mtd.reduce((sum, r) => sum + (toNumber(r.base_rounded_total) || toNumber(r.base_grand_total)), 0);
    lines.push(`📅 Month to date (${monthLabel(day)}): *${fmt.money(total)}*`);
  }

  const top = config.options.topCustomers;
  if (top > 0 && sales.length) {
    const byCustomer = new Map<string, { name: string; total: number }>();
    for (const row of sales) {
      const entry = byCustomer.get(row.customer) ?? { name: row.customer_name || row.customer, total: 0 };
      entry.total += amountOf(row);
      byCustomer.set(row.customer, entry);
    }
    const ranked = [...byCustomer.values()].sort((a, b) => b.total - a.total).slice(0, top);
    lines.push('');
    lines.push(`*Top customers*`);
    ranked.forEach((c, i) => lines.push(`${i + 1}. ${truncate(c.name, 40)} – ${fmt.money(c.total)}`));
  }

  return { text: lines.join('\n'), empty: false };
};
