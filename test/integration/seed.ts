/**
 * Creates demo data in a TEST ERPNext site for the integration tests.
 *
 * ⚠️ Never point this at a real company: it creates customers, suppliers, items,
 * invoices, payments and stock entries.
 */
import { todayInTz, addDays } from '../../src/util/time.js';

export interface AdminApi {
  url: string;
  key: string;
  secret: string;
}

export const COMPANY = 'Demo Trading LLC';
export const ABBR = 'DT';
/** A second company, to test "one WhatsApp number per company". */
export const BRANCH = 'Demo Branch LLC';
export const BRANCH_ABBR = 'DB';
export const TZ = 'Asia/Dubai';

export class Admin {
  constructor(private readonly api: AdminApi) {}

  private async req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.api.url}${path}`, {
      method,
      headers: { Authorization: `token ${this.api.key}:${this.api.secret}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 800)}`);
    return JSON.parse(text) as T;
  }

  async exists(doctype: string, name: string): Promise<boolean> {
    const res = await fetch(`${this.api.url}/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`, {
      headers: { Authorization: `token ${this.api.key}:${this.api.secret}` },
    });
    return res.ok;
  }

  async list(doctype: string, filters: unknown[] = [], fields: string[] = ['name']): Promise<Array<Record<string, any>>> {
    const query = new URLSearchParams({ filters: JSON.stringify(filters), fields: JSON.stringify(fields), limit_page_length: '0' });
    return (await this.req<{ data: Array<Record<string, any>> }>('GET', `/api/resource/${encodeURIComponent(doctype)}?${query}`)).data;
  }

  async insert<T = Record<string, any>>(doc: Record<string, unknown>): Promise<T> {
    const { doctype, ...rest } = doc;
    return (await this.req<{ data: T }>('POST', `/api/resource/${encodeURIComponent(String(doctype))}`, rest)).data;
  }

  async update(doctype: string, name: string, patch: Record<string, unknown>): Promise<Record<string, any>> {
    return (await this.req<{ data: any }>('PUT', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`, patch)).data;
  }

  async call<T = any>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return (await this.req<{ message: T }>('POST', `/api/method/${method}`, args)).message;
  }

  async ensure(doc: Record<string, unknown> & { doctype: string }, name: string): Promise<void> {
    if (!(await this.exists(doc.doctype, name))) await this.insert(doc);
  }

  /** Creates and submits a Sales Invoice. */
  async salesInvoice(customer: string, opts: { date?: string; dueDays?: number; qty?: number; rate?: number; isReturn?: boolean; returnAgainst?: string; company?: string } = {}) {
    const date = opts.date ?? todayInTz(TZ);
    const company = opts.company ?? COMPANY;
    const abbr = company === BRANCH ? BRANCH_ABBR : ABBR;
    return this.insert({
      doctype: 'Sales Invoice',
      customer,
      company,
      posting_date: date,
      set_posting_time: 1,
      due_date: opts.isReturn ? undefined : addDays(date, opts.dueDays ?? 10),
      is_return: opts.isReturn ? 1 : 0,
      return_against: opts.returnAgainst,
      items: [{ item_code: 'Widget A', qty: (opts.isReturn ? -1 : 1) * (opts.qty ?? 2), rate: opts.rate ?? 500, warehouse: `Stores - ${abbr}` }],
      docstatus: 1,
    });
  }

  /** Creates and submits a Purchase Invoice. */
  async purchaseInvoice(supplier: string, opts: { date?: string; dueDays?: number; billNo?: string; qty?: number; rate?: number } = {}) {
    const date = opts.date ?? todayInTz(TZ);
    return this.insert({
      doctype: 'Purchase Invoice',
      supplier,
      company: COMPANY,
      posting_date: date,
      set_posting_time: 1,
      bill_no: opts.billNo,
      bill_date: opts.billNo ? addDays(date, -1) : undefined,
      due_date: addDays(date, opts.dueDays ?? 30),
      items: [{ item_code: 'Widget B', qty: opts.qty ?? 5, rate: opts.rate ?? 120 }],
      docstatus: 1,
    });
  }

  /** Receives a payment (cash) against a Sales Invoice. */
  async receivePayment(invoice: string, amount?: number) {
    const pe = await this.call<Record<string, any>>('erpnext.accounts.doctype.payment_entry.payment_entry.get_payment_entry', { dt: 'Sales Invoice', dn: invoice });
    pe.mode_of_payment = 'Cash';
    pe.paid_to = `Cash - ${ABBR}`;
    pe.reference_no = `TEST-${Date.now()}`;
    pe.reference_date = todayInTz(TZ);
    if (amount) {
      pe.paid_amount = amount;
      pe.received_amount = amount;
      pe.references[0].allocated_amount = amount;
    }
    pe.docstatus = 1;
    return this.insert(pe);
  }
}

/** Master data + a few transactions. Safe to run more than once. */
export async function seed(admin: Admin): Promise<{ created: boolean }> {
  const today = todayInTz(TZ);

  await admin.ensure(
    { doctype: 'Company', company_name: BRANCH, abbr: BRANCH_ABBR, default_currency: 'AED', country: 'United Arab Emirates', create_chart_of_accounts_based_on: 'Standard Template', chart_of_accounts: 'Standard' },
    BRANCH,
  );
  await admin.ensure({ doctype: 'Account', account_name: 'Emirates NBD', parent_account: `Bank Accounts - ${ABBR}`, company: COMPANY, account_type: 'Bank', is_group: 0 }, `Emirates NBD - ${ABBR}`);

  for (const [name, reorder] of [
    ['Widget A', 20],
    ['Widget B', 5],
  ] as const) {
    await admin.ensure(
      {
        doctype: 'Item',
        item_code: name,
        item_name: name,
        item_group: 'Products',
        stock_uom: 'Nos',
        is_stock_item: 1,
        valuation_rate: 100,
        reorder_levels: [{ warehouse: `Stores - ${ABBR}`, warehouse_reorder_level: reorder, warehouse_reorder_qty: 50, material_request_type: 'Purchase' }],
      },
      name,
    );
  }

  const customers: Array<[string, string | undefined]> = [
    ['Acme Trading', '+971 50 123 4567'],
    ['Gamma Foods', '0559876543'],
    ['Beta Stores', undefined],
  ];
  for (const [name, mobile] of customers) {
    await admin.ensure({ doctype: 'Customer', customer_name: name, customer_type: 'Company', customer_group: 'Commercial', territory: 'United Arab Emirates', mobile_no: mobile }, name);
  }
  const suppliers: Array<[string, string | undefined]> = [
    ['Delta Supplies', '+971 52 765 4321'],
    ['Epsilon Parts', undefined],
  ];
  for (const [name, mobile] of suppliers) {
    await admin.ensure({ doctype: 'Supplier', supplier_name: name, supplier_group: 'Local', mobile_no: mobile }, name);
  }

  // Transactions only once (marker: the opening journal entry).
  const existing = await admin.list('Journal Entry', [['user_remark', '=', 'auto-sms seed opening']]);
  if (existing.length) return { created: false };

  await admin.insert({
    doctype: 'Journal Entry',
    company: COMPANY,
    posting_date: addDays(today, -60),
    user_remark: 'auto-sms seed opening',
    accounts: [
      { account: `Emirates NBD - ${ABBR}`, debit_in_account_currency: 50000 },
      { account: `Cash - ${ABBR}`, debit_in_account_currency: 2500 },
      { account: `Opening Balance Equity - ${ABBR}`, credit_in_account_currency: 52500 },
    ],
    docstatus: 1,
  });

  // Stock: Widget A below re-order level (10 < 20), Widget B above (50 > 5).
  await admin.insert({
    doctype: 'Stock Entry',
    stock_entry_type: 'Material Receipt',
    company: COMPANY,
    posting_date: addDays(today, -30),
    set_posting_time: 1,
    items: [
      { item_code: 'Widget A', qty: 10, t_warehouse: `Stores - ${ABBR}`, basic_rate: 300 },
      { item_code: 'Widget B', qty: 50, t_warehouse: `Stores - ${ABBR}`, basic_rate: 120 },
    ],
    docstatus: 1,
  });

  // An old, overdue invoice; one from yesterday; two from today (one partly paid).
  await admin.salesInvoice('Gamma Foods', { date: addDays(today, -45), dueDays: 15, qty: 4, rate: 750 });
  await admin.salesInvoice('Beta Stores', { date: addDays(today, -1), qty: 1, rate: 400 });
  const paid = await admin.salesInvoice('Acme Trading', { date: today, qty: 3, rate: 500 });
  await admin.salesInvoice('Beta Stores', { date: today, qty: 2, rate: 450 });
  await admin.receivePayment(paid.name, 1000);

  await admin.purchaseInvoice('Delta Supplies', { date: addDays(today, -40), dueDays: 20, billNo: 'DS-1001', qty: 10, rate: 110 });
  await admin.purchaseInvoice('Epsilon Parts', { date: addDays(today, -2), billNo: 'EP-77', qty: 3, rate: 90 });
  return { created: true };
}
