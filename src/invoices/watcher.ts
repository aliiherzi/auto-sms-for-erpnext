/**
 * Watches ERPNext for newly submitted invoices (polling – nothing to install in ERPNext).
 *
 * How it avoids sending old invoices, missing invoices, or sending twice:
 *  - on first start it remembers the newest "modified" timestamp and today's date, and
 *    marks the invoices of the last few minutes as already handled; only invoices dated
 *    from that day on are sent automatically
 *  - each poll asks for submitted invoices modified since the last checkpoint, minus a
 *    10 minute overlap (a slow save can commit after a newer one)
 *  - every handled invoice is recorded locally (processed_docs), so the overlap, payments
 *    or edits that touch an invoice again never trigger a second message
 *  - invoices dated more than `maxAgeDays` ago are ignored by automatic sending
 */
import type { Database } from '../db/database.js';
import type { ErpNextClient, Filter } from '../erpnext/client.js';
import type { ContextResolver } from '../erpnext/context.js';
import type { Settings } from '../config/settings.js';
import type { Logger } from '../util/logger.js';
import { addDays, todayInTz } from '../util/time.js';
import { INVOICE_DOCTYPES, type InvoiceDoctype, type InvoiceService } from './service.js';

const PAGE = 100;
export const OVERLAP_MINUTES = 10;

/** Subtracts minutes from an ERPNext timestamp string ("YYYY-MM-DD HH:MM:SS[.ffffff]"). */
export function minusMinutes(timestamp: string, minutes: number): string {
  const match = timestamp.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (!match) return timestamp;
  const date = new Date(`${match[1]}T${match[2]}Z`);
  date.setUTCMinutes(date.getUTCMinutes() - minutes);
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

export class InvoiceWatcher {
  private timer?: NodeJS.Timeout;
  private running = false;
  private busy = false;
  private readonly log: Logger;
  lastPollAt: string | null = null;
  lastError: string | null = null;

  constructor(
    private readonly deps: {
      db: Database;
      service: InvoiceService;
      erp: () => ErpNextClient;
      settings: () => Settings;
      context: ContextResolver;
      logger: Logger;
    },
  ) {
    this.log = deps.logger.child({ scope: 'watcher' });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(2_000);
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      await this.pollOnce().catch(() => undefined);
      this.schedule(this.deps.settings().invoices.pollIntervalSeconds * 1000);
    }, ms);
    this.timer.unref();
  }

  private enabledDoctypes(): InvoiceDoctype[] {
    const s = this.deps.settings().invoices;
    return INVOICE_DOCTYPES.filter((d) => (d === 'Sales Invoice' ? s.sales.enabled : s.purchase.enabled));
  }

  /** One polling round for all enabled invoice types. */
  async pollOnce(): Promise<{ checked: number; processed: number }> {
    if (this.busy) return { checked: 0, processed: 0 };
    const erp = this.deps.erp();
    if (!erp.configured) return { checked: 0, processed: 0 };
    this.busy = true;
    let checked = 0;
    let processed = 0;
    try {
      const timezone = (await this.deps.context.resolve()).timezone;
      for (const doctype of this.enabledDoctypes()) {
        const result = await this.pollDoctype(doctype, erp, timezone);
        checked += result.checked;
        processed += result.processed;
      }
      // Invoices that failed earlier for a temporary reason (ERPNext busy, PDF error…).
      for (const doc of this.deps.db.docsToRetry()) {
        if (!INVOICE_DOCTYPES.includes(doc.doctype as InvoiceDoctype)) continue;
        await this.deps.service.process(doc.doctype as InvoiceDoctype, doc.name, { source: 'poll' }).then(
          () => processed++,
          () => undefined,
        );
      }
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.log.warn(`Polling ERPNext failed: ${this.lastError}`);
      throw error;
    } finally {
      this.lastPollAt = new Date().toISOString();
      this.busy = false;
    }
    return { checked, processed };
  }

  /** Company filter: every company when there is a catch-all profile, else only the listed ones. */
  private companyFilter(): Filter | null {
    const profiles = this.deps.settings().companies;
    if (profiles.some((p) => !p.company)) return null;
    return ['company', 'in', profiles.map((p) => p.company)];
  }

  private async pollDoctype(doctype: InvoiceDoctype, erp: ErpNextClient, timezone: string): Promise<{ checked: number; processed: number }> {
    const { db, settings } = this.deps;
    const keyCheckpoint = `watch:${doctype}:checkpoint`;
    const keyBaseline = `watch:${doctype}:baseline_date`;
    const today = todayInTz(timezone);

    let checkpoint = db.getKv(keyCheckpoint);
    let baseline = db.getKv(keyBaseline);
    if (!checkpoint || !baseline) {
      const latest = await erp.getList<{ modified: string }>(doctype, {
        fields: ['modified'],
        filters: [['docstatus', '=', 1]],
        orderBy: 'modified desc',
        limit: 1,
      });
      checkpoint = latest[0]?.modified ?? '1970-01-01 00:00:00';
      baseline = today;
      // Invoices inside the overlap window existed before we started: never send them automatically.
      if (latest.length) {
        const recent = await erp.getAll<{ name: string }>(doctype, {
          fields: ['name'],
          filters: [
            ['docstatus', '=', 1],
            ['modified', '>=', minusMinutes(checkpoint, OVERLAP_MINUTES)],
          ],
        });
        for (const row of recent) db.setProcessed(doctype, row.name, 'skipped', 'existed before the service started');
      }
      db.setKv(keyCheckpoint, checkpoint);
      db.setKv(keyBaseline, baseline);
      this.log.info(`Started watching ${doctype}: invoices submitted from now on (dated ${baseline} or later) will be sent.`);
      return { checked: 0, processed: 0 };
    }

    const maxAge = settings().invoices.maxAgeDays;
    const oldestAllowed = addDays(today, -maxAge);
    const minDate = baseline > oldestAllowed ? baseline : oldestAllowed;
    const filters: Filter[] = [
      ['docstatus', '=', 1],
      ['modified', '>=', minusMinutes(checkpoint, OVERLAP_MINUTES)],
      ['posting_date', '>=', minDate],
    ];
    const companyFilter = this.companyFilter();
    if (companyFilter) filters.push(companyFilter);

    let newest = checkpoint;
    let checked = 0;
    let processed = 0;
    for (let start = 0; ; start += PAGE) {
      const rows = await erp.getList<{ name: string; modified: string }>(doctype, {
        fields: ['name', 'modified'],
        filters,
        orderBy: 'modified asc',
        start,
        limit: PAGE,
      });
      for (const row of rows) {
        checked++;
        if (row.modified > newest) newest = row.modified;
        if (db.getProcessed(doctype, row.name)) continue;
        try {
          const result = await this.deps.service.process(doctype, row.name, { source: 'poll' });
          if (result.status === 'queued') processed++;
        } catch {
          // already logged and marked for retry by the service
        }
      }
      if (rows.length < PAGE) break;
    }
    db.setKv(keyCheckpoint, newest);
    return { checked, processed };
  }

  /** For the dashboard. */
  status(): Record<string, unknown> {
    const { db } = this.deps;
    return {
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      watching: this.enabledDoctypes().map((d) => ({ doctype: d, since: db.getKv(`watch:${d}:baseline_date`), checkpoint: db.getKv(`watch:${d}:checkpoint`) })),
    };
  }
}
