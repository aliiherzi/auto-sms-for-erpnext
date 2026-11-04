/**
 * Behaviour settings (everything except bootstrap secrets).
 *
 * Stored in DATA_DIR/settings.json and edited from the dashboard. Every field has a
 * default, so an old or partial file is always upgraded to the current shape.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DATE_FORMATS } from '../util/time.js';

// ---------------------------------------------------------------------------
// Default message templates
// ---------------------------------------------------------------------------

export const DEFAULT_SALES_PARTY_MESSAGE = `Dear {{party_name}},

Please find attached your {{doc_label}} *{{name}}* dated {{posting_date}}.

Amount: *{{grand_total}}*
{{#due_date}}Due date: {{due_date}}{{/due_date}}

Thank you for your business.
*{{company}}*`;

export const DEFAULT_SALES_GROUP_MESSAGE = `🧾 *New {{doc_title}}* {{name}}
Customer: {{party_name}}
Amount: *{{grand_total}}*
{{#due_date}}Due: {{due_date}}{{/due_date}}
{{party_delivery}}`;

export const DEFAULT_PURCHASE_PARTY_MESSAGE = `Dear {{party_name}},

We confirm that we have received and recorded your invoice{{#bill_no}} *{{bill_no}}*{{/bill_no}}.

Our reference: {{name}}
{{#bill_date}}Invoice date: {{bill_date}}{{/bill_date}}
Amount: *{{grand_total}}*
{{#due_date}}Payment due: {{due_date}}{{/due_date}}

*{{company}}*`;

export const DEFAULT_PURCHASE_GROUP_MESSAGE = `📥 *New {{doc_title}}* {{name}}
Supplier: {{party_name}}
{{#bill_no}}Supplier invoice no: {{bill_no}}{{/bill_no}}
Amount: *{{grand_total}}*
{{#due_date}}Due: {{due_date}}{{/due_date}}
{{party_delivery}}`;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const groupList = z.array(z.string()).default(() => []);

function invoiceSettings(defaults: { partyMessage: string; groupMessage: string }) {
  return z.object({
    enabled: z.boolean().default(true),
    /** Send the invoice to the customer / supplier's own WhatsApp number. */
    sendToParty: z.boolean().default(true),
    attachPdf: z.boolean().default(true),
    /** ERPNext Print Format name; empty = the doctype's default print format. */
    printFormat: z.string().default(''),
    /** Letter Head name; empty = ERPNext default letter head. */
    letterhead: z.string().default(''),
    /** Also send credit notes / debit notes (returns). */
    includeReturns: z.boolean().default(true),
    partyMessage: z.string().default(defaults.partyMessage),
    groupMessage: z.string().default(defaults.groupMessage),
  });
}

const reportCommon = {
  id: z.string().min(1),
  /** Optional name shown in the dashboard and message header. */
  title: z.string().default(''),
  enabled: z.boolean().default(true),
  /** Cron expression: minute hour day-of-month month day-of-week. */
  schedule: z.string().default('0 20 * * *'),
  /** ERPNext company the report is about; empty = ERPNext's default company. */
  company: z.string().default(''),
  /** Target WhatsApp groups; empty = the report groups of the company's profile. */
  groups: groupList,
};

const DailySalesReport = z.object({
  ...reportCommon,
  type: z.literal('daily_sales'),
  options: z
    .object({
      day: z.enum(['today', 'yesterday']).default('today'),
      topCustomers: z.number().int().min(0).max(50).default(5),
      includePayments: z.boolean().default(true),
      includeMonthToDate: z.boolean().default(true),
    })
    .prefault({}),
});

const outstandingOptions = z
  .object({
    topParties: z.number().int().min(1).max(50).default(10),
    onlyOverdue: z.boolean().default(false),
  })
  .prefault({});

const ReceivablesReport = z.object({ ...reportCommon, type: z.literal('receivables'), options: outstandingOptions });
const PayablesReport = z.object({ ...reportCommon, type: z.literal('payables'), options: outstandingOptions });

const StockAlertsReport = z.object({
  ...reportCommon,
  type: z.literal('stock_alerts'),
  options: z
    .object({
      basedOn: z.enum(['actual_qty', 'projected_qty']).default('actual_qty'),
      maxItems: z.number().int().min(1).max(200).default(30),
      sendWhenEmpty: z.boolean().default(false),
      /** Limit to these warehouses; empty = all warehouses of the company. */
      warehouses: z.array(z.string()).default(() => []),
    })
    .prefault({}),
});

const CashBankReport = z.object({
  ...reportCommon,
  type: z.literal('cash_bank'),
  options: z
    .object({
      /** Limit to these accounts; empty = every Bank and Cash account of the company. */
      accounts: z.array(z.string()).default(() => []),
      hideZero: z.boolean().default(false),
    })
    .prefault({}),
});

const QueryReport = z.object({
  ...reportCommon,
  type: z.literal('query_report'),
  options: z
    .object({
      /** Any ERPNext report name, e.g. "Gross Profit" or "Accounts Receivable Summary". */
      reportName: z.string().default(''),
      /** Report filters. Values may use {{today}}, {{yesterday}}, {{week_start}}, {{month_start}}, {{year_start}}, {{company}}. */
      filters: z.record(z.string(), z.unknown()).default(() => ({})),
      /** Column fieldnames to show in the text version; empty = first 4 columns. */
      columns: z.array(z.string()).default(() => []),
      maxRows: z.number().int().min(1).max(200).default(20),
      /** text = table in the message, csv = full report attached as a CSV file. */
      output: z.enum(['text', 'csv']).default('text'),
      sendWhenEmpty: z.boolean().default(true),
    })
    .prefault({}),
});

export const ReportSchema = z.discriminatedUnion('type', [
  DailySalesReport,
  ReceivablesReport,
  PayablesReport,
  StockAlertsReport,
  CashBankReport,
  QueryReport,
]);

export const REPORT_TYPES = ['daily_sales', 'receivables', 'payables', 'stock_alerts', 'cash_bank', 'query_report'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  daily_sales: 'Daily sales summary',
  receivables: 'Receivables (customers who owe you)',
  payables: 'Payables (what you owe suppliers)',
  stock_alerts: 'Low stock alerts',
  cash_bank: 'Cash & bank balances',
  query_report: 'Any ERPNext report',
};

export const DEFAULT_REPORTS = [
  { id: 'daily-sales', type: 'daily_sales', schedule: '0 20 * * *' },
  { id: 'receivables', type: 'receivables', schedule: '0 9 * * *' },
  { id: 'payables', type: 'payables', schedule: '5 9 * * *' },
  { id: 'stock-alerts', type: 'stock_alerts', schedule: '0 8 * * *' },
  { id: 'cash-bank', type: 'cash_bank', schedule: '5 20 * * *' },
].map((r) => ReportSchema.parse(r));

/** A linked WhatsApp number. Its session lives in DATA_DIR/whatsapp-auth/<id>. */
export const AccountSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'Account id: lowercase letters, digits and dashes'),
  label: z.string().default(''),
});

/** Which WhatsApp number (and which groups) an ERPNext company uses. */
export const CompanyProfileSchema = z.object({
  /** ERPNext company name; empty = every company without a profile of its own. */
  company: z.string().default(''),
  accountId: z.string().default('main'),
  /** Groups that get a copy of each customer invoice. */
  salesGroups: groupList,
  /** Groups that get a copy of each supplier invoice. */
  purchaseGroups: groupList,
  /** Groups that receive this company's reports (unless a report picks its own). */
  reportGroups: groupList,
});

export const DEFAULT_ACCOUNT_ID = 'main';

export const SettingsSchema = z.object({
  version: z.literal(1).default(1),
  whatsapp: z
    .object({
      accounts: z.array(AccountSchema).min(1, 'Keep at least one WhatsApp number').default(() => [{ id: DEFAULT_ACCOUNT_ID, label: 'Main number' }]),
    })
    .prefault({}),
  /** One entry per company (or one catch-all entry with company ""). */
  companies: z.array(CompanyProfileSchema).default(() => [{ company: '', accountId: DEFAULT_ACCOUNT_ID, salesGroups: [], purchaseGroups: [], reportGroups: [] }]),
  erpnext: z
    .object({
      url: z.string().default(''),
      apiKey: z.string().default(''),
      apiSecret: z.string().default(''),
    })
    .prefault({}),
  general: z
    .object({
      /** IANA time zone, e.g. "Asia/Dubai"; empty = ERPNext's system time zone. */
      timezone: z.string().default(''),
      /** Used for local numbers like 050…; digits only, e.g. "971". */
      defaultCountryCode: z.string().regex(/^\d{0,4}$/, 'Country code must be digits only, e.g. 971').default(''),
      dateFormat: z.enum(DATE_FORMATS).default('DD-MM-YYYY'),
      numberLocale: z.string().default('en-US'),
      /** Pause between WhatsApp messages, to look human and protect the number. */
      sendDelaySeconds: z.number().min(1).max(120).default(5),
      /** While on, messages for customers and suppliers go to testRecipient instead. */
      testMode: z.boolean().default(true),
      /** Phone number or group ID that receives test-mode messages. Empty = log only. */
      testRecipient: z.string().default(''),
    })
    .prefault({}),
  invoices: z
    .object({
      pollIntervalSeconds: z.number().int().min(15).max(3600).default(60),
      /** Automatic sending ignores invoices whose posting date is older than this. */
      maxAgeDays: z.number().int().min(0).max(365).default(3),
      /** Optional custom field on Customer/Supplier holding the WhatsApp number (takes priority). */
      whatsappField: z.string().default(''),
      /** ERPNext v16+: which PDF renderer to use; empty = ERPNext's Print Settings. */
      pdfGenerator: z.enum(['', 'chrome', 'wkhtmltopdf']).default(''),
      sales: invoiceSettings({ partyMessage: DEFAULT_SALES_PARTY_MESSAGE, groupMessage: DEFAULT_SALES_GROUP_MESSAGE }).prefault({}),
      purchase: invoiceSettings({ partyMessage: DEFAULT_PURCHASE_PARTY_MESSAGE, groupMessage: DEFAULT_PURCHASE_GROUP_MESSAGE }).prefault({}),
    })
    .prefault({}),
  reports: z
    .object({
      items: z.array(ReportSchema).default(() => structuredClone(DEFAULT_REPORTS)),
    })
    .prefault({}),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type ReportConfig = z.infer<typeof ReportSchema>;
export type InvoiceSettings = Settings['invoices']['sales'];
export type CompanyProfile = z.infer<typeof CompanyProfileSchema>;
export type WhatsAppAccount = z.infer<typeof AccountSchema>;

/** The profile for an ERPNext company: its own entry, else the catch-all entry, else none. */
export function profileFor(settings: Settings, company: string): CompanyProfile | null {
  return settings.companies.find((p) => p.company && p.company === company) ?? settings.companies.find((p) => !p.company) ?? null;
}

/** Cross-field checks zod can't express on its own. Returns a list of problems. */
export function settingsProblems(settings: Settings): string[] {
  const problems: string[] = [];
  const accountIds = new Set<string>();
  for (const account of settings.whatsapp.accounts) {
    if (accountIds.has(account.id)) problems.push(`Two WhatsApp numbers share the id "${account.id}"`);
    accountIds.add(account.id);
  }
  const companies = new Set<string>();
  for (const profile of settings.companies) {
    const name = profile.company || 'All other companies';
    if (companies.has(profile.company)) problems.push(`"${name}" is listed twice under Companies`);
    companies.add(profile.company);
    if (!accountIds.has(profile.accountId)) problems.push(`"${name}" uses a WhatsApp number that doesn't exist (${profile.accountId})`);
  }
  const reportIds = new Set<string>();
  for (const report of settings.reports.items) {
    if (reportIds.has(report.id)) problems.push(`Two reports share the id "${report.id}"`);
    reportIds.add(report.id);
  }
  return problems;
}

export function defaultSettings(): Settings {
  return SettingsSchema.parse({});
}

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join('.') : 'settings'}: ${issue.message}`)
    .join('; ');
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Values that come from environment variables override the file and are read-only in the UI. */
export interface SettingsOverrides {
  erpnextUrl?: string;
  erpnextApiKey?: string;
  erpnextApiSecret?: string;
}

export class SettingsStore extends EventEmitter {
  private current: Settings;
  readonly file: string;

  constructor(
    dataDir: string,
    private overrides: SettingsOverrides = {},
  ) {
    super();
    this.file = path.join(dataDir, 'settings.json');
    this.current = this.load();
  }

  private load(): Settings {
    if (!fs.existsSync(this.file)) {
      const fresh = defaultSettings();
      this.write(fresh);
      return fresh;
    }
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const parsed = SettingsSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid ${this.file}: ${formatZodError(parsed.error)}`);
    }
    // Upgrade the file to the current shape so every option is visible in it.
    if (JSON.stringify(raw) !== JSON.stringify(parsed.data)) this.write(parsed.data);
    return parsed.data;
  }

  private write(settings: Settings): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Settings with environment overrides applied. */
  get(): Settings {
    const s = structuredClone(this.current);
    if (this.overrides.erpnextUrl) s.erpnext.url = this.overrides.erpnextUrl;
    if (this.overrides.erpnextApiKey) s.erpnext.apiKey = this.overrides.erpnextApiKey;
    if (this.overrides.erpnextApiSecret) s.erpnext.apiSecret = this.overrides.erpnextApiSecret;
    return s;
  }

  /** Which fields are fixed by environment variables. */
  lockedFields(): string[] {
    const locked: string[] = [];
    if (this.overrides.erpnextUrl) locked.push('erpnext.url');
    if (this.overrides.erpnextApiKey) locked.push('erpnext.apiKey');
    if (this.overrides.erpnextApiSecret) locked.push('erpnext.apiSecret');
    return locked;
  }

  /** Validates and saves new settings. Throws with a readable message when invalid. */
  update(input: unknown): Settings {
    const parsed = SettingsSchema.safeParse(input);
    if (!parsed.success) throw new SettingsValidationError(formatZodError(parsed.error));
    const problems = settingsProblems(parsed.data);
    if (problems.length) throw new SettingsValidationError(problems.join('; '));
    const previous = this.current;
    this.current = parsed.data;
    this.write(this.current);
    this.emit('change', this.get(), previous);
    return this.get();
  }
}

export class SettingsValidationError extends Error {}
