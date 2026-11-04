/**
 * ERPNext / Frappe REST API client (token authentication).
 *
 * Uses only the stable v1 endpoints (/api/resource and /api/method), which work on
 * ERPNext v13, v14, v15 and v16.
 */
import { stripHtml } from '../util/format.js';

export interface ErpNextConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
  /** Default request timeout (ms). */
  timeoutMs?: number;
}

/** [field, operator, value] or [child doctype, field, operator, value] */
export type Filter = [string, string, unknown] | [string, string, string, unknown];

export interface ListOptions {
  fields?: string[];
  filters?: Filter[];
  orFilters?: Filter[];
  orderBy?: string;
  limit?: number;
  start?: number;
  /** Parent doctype, required when listing a child table (e.g. "Item" for "Item Reorder"). */
  parent?: string;
}

export interface ReportColumn {
  fieldname: string;
  label: string;
  fieldtype: string;
  options?: string;
}

export interface ReportResult {
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  message?: string;
}

export class ErpNextError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly excType?: string,
  ) {
    super(message);
    this.name = 'ErpNextError';
  }

  /** True for errors that will not go away by retrying (bad credentials, missing document…). */
  get permanent(): boolean {
    return [400, 401, 403, 404, 409, 417].includes(this.status);
  }
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface RequestOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  timeoutMs?: number;
  binary?: boolean;
}

export function normalizeErpNextUrl(url: string): string {
  let value = (url || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  value = value.replace(/\/+$/, '');
  // People often paste a desk URL such as https://erp.example.com/app/sales-invoice
  value = value.replace(/\/(app|desk)(\/.*)?$/i, '');
  return value;
}

function encodeQuery(query: Record<string, unknown> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') params.set(key, JSON.stringify(value));
    else if (typeof value === 'boolean') params.set(key, value ? '1' : '0');
    else params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** Pulls a human readable message out of a Frappe error response. */
export function extractFrappeError(body: unknown): { message?: string; excType?: string } {
  if (!body || typeof body !== 'object') return {};
  const data = body as Record<string, unknown>;
  const excType = typeof data.exc_type === 'string' ? data.exc_type : undefined;
  const messages: string[] = [];
  if (typeof data._server_messages === 'string') {
    try {
      for (const item of JSON.parse(data._server_messages) as unknown[]) {
        try {
          const parsed = typeof item === 'string' ? JSON.parse(item) : item;
          const text = typeof parsed === 'object' && parsed ? (parsed as { message?: unknown }).message : parsed;
          if (text) messages.push(stripHtml(String(text)));
        } catch {
          messages.push(stripHtml(String(item)));
        }
      }
    } catch {
      // ignore
    }
  }
  if (!messages.length && typeof data.exception === 'string') {
    const text = data.exception.replace(/^[\w.]+(Error|Exception):\s*/, '');
    messages.push(stripHtml(text));
  }
  if (!messages.length && Array.isArray(data.errors)) {
    for (const err of data.errors as Array<{ message?: string }>) if (err?.message) messages.push(stripHtml(err.message));
  }
  if (!messages.length && typeof data.message === 'string' && data.message.length < 500) messages.push(stripHtml(data.message));
  return { message: messages.filter(Boolean).join(' ') || undefined, excType };
}

export class ErpNextClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: ErpNextConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.baseUrl = normalizeErpNextUrl(config.url);
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  get configured(): boolean {
    return Boolean(this.baseUrl && this.config.apiKey && this.config.apiSecret);
  }

  private async request(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<unknown> {
    if (!this.configured) throw new ErpNextError('ERPNext is not configured yet (URL, API key and API secret are required).', 0);
    const url = `${this.baseUrl}${path}${encodeQuery(options.query)}`;
    const headers: Record<string, string> = {
      Authorization: `token ${this.config.apiKey}:${this.config.apiSecret}`,
      Accept: options.binary ? 'application/pdf, application/octet-stream, */*' : 'application/json',
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
      });
    } catch (error) {
      const err = error as Error & { cause?: { code?: string; message?: string } };
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new ErpNextError(`ERPNext did not answer in time (${method} ${path})`, 0);
      }
      const reason = err.cause?.code || err.cause?.message || err.message;
      throw new ErpNextError(`Cannot reach ERPNext at ${this.baseUrl}: ${reason}`, 0);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!response.ok) {
      let parsed: { message?: string; excType?: string } = {};
      const text = await response.text();
      if (contentType.includes('json')) {
        try {
          parsed = extractFrappeError(JSON.parse(text));
        } catch {
          // fall through
        }
      }
      let message = parsed.message;
      if (response.status === 401 || parsed.excType === 'AuthenticationError') {
        message = `ERPNext rejected the API key/secret (${response.status}). Check them in ERPNext → User → API Access.${message ? ` (${message})` : ''}`;
      } else if (response.status === 403 && !message) {
        message = 'Permission denied by ERPNext. Give the API user the roles it needs (see README).';
      } else if (!message) {
        message = `ERPNext returned HTTP ${response.status} for ${method} ${path}`;
      }
      throw new ErpNextError(message, response.status, parsed.excType);
    }

    if (options.binary) {
      if (contentType.includes('text/html') || contentType.includes('application/json')) {
        const text = await response.text();
        let message = 'ERPNext did not return a file';
        try {
          message = extractFrappeError(JSON.parse(text)).message || message;
        } catch {
          // HTML login page or error page
          if (/login/i.test(text)) message = 'ERPNext returned its login page – check the API key/secret';
        }
        throw new ErpNextError(message, 502);
      }
      return Buffer.from(await response.arrayBuffer());
    }

    const text = await response.text();
    if (!contentType.includes('json')) {
      if (/<html/i.test(text)) {
        throw new ErpNextError(`${this.baseUrl} answered with a web page instead of the API. Is this the right ERPNext address?`, 502);
      }
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ErpNextError(`Unexpected response from ERPNext for ${method} ${path}`, 502);
    }
  }

  /** Calls a whitelisted server method and returns its "message". */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, httpMethod: 'GET' | 'POST' = 'GET', timeoutMs?: number): Promise<T> {
    const path = `/api/method/${method}`;
    const response = (httpMethod === 'GET'
      ? await this.request('GET', path, { query: params, timeoutMs })
      : await this.request('POST', path, { body: params, timeoutMs })) as { message?: T };
    return response.message as T;
  }

  async getLoggedUser(): Promise<string> {
    return this.call<string>('frappe.auth.get_logged_user');
  }

  /** e.g. { frappe: "16.3.0", erpnext: "16.53.0" } */
  async getVersions(): Promise<Record<string, string>> {
    try {
      const versions = await this.call<Record<string, { version?: string }>>('frappe.utils.change_log.get_versions');
      return Object.fromEntries(Object.entries(versions || {}).map(([app, info]) => [app, info?.version ?? '']));
    } catch {
      return {};
    }
  }

  async getList<T = Record<string, unknown>>(doctype: string, options: ListOptions = {}): Promise<T[]> {
    const response = (await this.request('GET', `/api/resource/${encodeURIComponent(doctype)}`, {
      query: {
        fields: options.fields ?? ['name'],
        filters: options.filters,
        or_filters: options.orFilters,
        order_by: options.orderBy,
        limit_start: options.start ?? 0,
        limit_page_length: options.limit ?? 20,
        parent: options.parent,
      },
    })) as { data?: T[] };
    return response.data ?? [];
  }

  /** Fetches every matching row, page by page. */
  async getAll<T = Record<string, unknown>>(doctype: string, options: Omit<ListOptions, 'limit' | 'start'> & { pageSize?: number; max?: number } = {}): Promise<T[]> {
    const pageSize = options.pageSize ?? 500;
    const max = options.max ?? 100_000;
    const rows: T[] = [];
    for (let start = 0; rows.length < max; start += pageSize) {
      const page = await this.getList<T>(doctype, { ...options, start, limit: pageSize });
      rows.push(...page);
      if (page.length < pageSize) break;
    }
    return rows.slice(0, max);
  }

  async getDoc<T = Record<string, unknown>>(doctype: string, name: string): Promise<T> {
    const response = (await this.request('GET', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`)) as { data: T };
    return response.data;
  }

  async exists(doctype: string, name: string): Promise<boolean> {
    try {
      await this.getDoc(doctype, name);
      return true;
    } catch (error) {
      if (error instanceof ErpNextError && error.status === 404) return false;
      throw error;
    }
  }

  /** Downloads the print PDF of a document using ERPNext's own print formats. */
  async downloadPdf(
    doctype: string,
    name: string,
    options: { printFormat?: string; letterhead?: string; noLetterhead?: boolean; language?: string; pdfGenerator?: string } = {},
  ): Promise<Buffer> {
    let pdf: Buffer;
    try {
      pdf = (await this.request('GET', '/api/method/frappe.utils.print_format.download_pdf', {
        query: {
          doctype,
          name,
          format: options.printFormat || undefined,
          letterhead: options.letterhead || undefined,
          no_letterhead: options.noLetterhead ? 1 : 0,
          language: options.language || undefined,
          // ERPNext v16+ only; older versions ignore it.
          pdf_generator: options.pdfGenerator || undefined,
        },
        binary: true,
        timeoutMs: 120_000,
      })) as Buffer;
    } catch (error) {
      if (error instanceof ErpNextError && error.status >= 500) {
        throw new ErpNextError(
          `ERPNext could not create the PDF for ${doctype} ${name}: ${error.message}. ` +
            'Check that Print → PDF works for this invoice inside ERPNext. On ERPNext v16 the Chrome PDF renderer is downloaded on first use; ' +
            'if the ERPNext server has no internet access, choose "wkhtmltopdf" as PDF generator in this app\'s invoice settings.',
          error.status,
          error.excType,
        );
      }
      throw error;
    }
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new ErpNextError(`ERPNext returned something that is not a PDF for ${doctype} ${name}`, 502);
    }
    return pdf;
  }

  /** Runs any query/script report and returns normalised columns and rows. */
  async runQueryReport(reportName: string, filters: Record<string, unknown> = {}): Promise<ReportResult> {
    const message = await this.call<{
      columns?: unknown[];
      result?: unknown[];
      message?: unknown;
      prepared_report?: boolean;
    }>('frappe.desk.query_report.run', { report_name: reportName, filters, ignore_prepared_report: true, are_default_filters: false }, 'POST', 180_000);
    if (!message) throw new ErpNextError(`Report "${reportName}" returned nothing. Does the API user have access to it?`, 403);
    const columns = (message.columns ?? []).map(normalizeColumn);
    const rows = (message.result ?? [])
      .filter((row) => row !== null && row !== undefined)
      .map((row) => {
        if (Array.isArray(row)) {
          const record: Record<string, unknown> = {};
          columns.forEach((col, i) => (record[col.fieldname] = row[i]));
          return record;
        }
        return row as Record<string, unknown>;
      });
    return { columns, rows, message: typeof message.message === 'string' ? stripHtml(message.message) : undefined };
  }

  /** Balance of an account on a date, in the account's currency. */
  async getBalanceOn(account: string, date: string, company?: string): Promise<number> {
    const value = await this.call<number | string>('erpnext.accounts.utils.get_balance_on', { account, date, company });
    return Number(value) || 0;
  }

  /** Default company from Global Defaults, or the first company the API user can see. */
  async getDefaultCompany(): Promise<string | null> {
    try {
      const value = await this.call<string>('frappe.client.get_single_value', { doctype: 'Global Defaults', field: 'default_company' });
      if (value) return value;
    } catch {
      // the API user may not be allowed to read Global Defaults
    }
    const companies = await this.getList<{ name: string }>('Company', { fields: ['name'], limit: 1, orderBy: 'creation asc' });
    return companies[0]?.name ?? null;
  }

  /** ERPNext's time zone (System Settings), or the API user's own time zone when System Settings is not readable. */
  async getSystemTimeZone(): Promise<string | null> {
    try {
      const tz = await this.call<string>('frappe.client.get_single_value', { doctype: 'System Settings', field: 'time_zone' });
      if (tz) return tz;
    } catch {
      // only System Managers can read System Settings
    }
    try {
      const user = await this.getLoggedUser();
      const doc = await this.getDoc<{ time_zone?: string }>('User', user);
      return doc.time_zone || null;
    } catch {
      return null;
    }
  }

  async getCompanyCurrency(company: string): Promise<string> {
    const doc = await this.getDoc<{ default_currency?: string }>('Company', company);
    return doc.default_currency || '';
  }
}

function scrub(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** Columns come either as objects or as "Label:Fieldtype/Options:Width" strings. */
export function normalizeColumn(column: unknown): ReportColumn {
  if (typeof column === 'string') {
    const [label = '', typePart = 'Data'] = column.split(':');
    const [fieldtype = 'Data', options] = typePart.split('/');
    return { label, fieldname: scrub(label), fieldtype: fieldtype || 'Data', options };
  }
  const col = (column ?? {}) as Record<string, unknown>;
  const label = String(col.label ?? col.fieldname ?? '');
  return {
    label,
    fieldname: String(col.fieldname ?? scrub(label)),
    fieldtype: String(col.fieldtype ?? 'Data'),
    options: col.options ? String(col.options) : undefined,
  };
}
