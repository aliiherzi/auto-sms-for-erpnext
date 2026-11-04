/**
 * Runs reports on their cron schedules (in the business time zone) and queues
 * the result for the configured WhatsApp groups.
 */
import { Cron } from 'croner';
import type { Database } from '../db/database.js';
import type { ErpNextClient } from '../erpnext/client.js';
import type { ContextResolver } from '../erpnext/context.js';
import type { Outbox } from '../messaging/outbox.js';
import { profileFor, REPORT_TYPE_LABELS, type ReportConfig, type Settings } from '../config/settings.js';
import type { Logger } from '../util/logger.js';
import { todayInTz } from '../util/time.js';
import { cashBank } from './cash-bank.js';
import { dailySales } from './daily-sales.js';
import { outstanding } from './outstanding.js';
import { queryReport } from './query-report.js';
import { stockAlerts } from './stock-alerts.js';
import { makeFormatters, type ReportContext, type ReportOutput } from './types.js';

export function reportTitle(config: ReportConfig): string {
  return config.title || (config.type === 'query_report' && config.options.reportName ? config.options.reportName : REPORT_TYPE_LABELS[config.type]);
}

export async function buildReport(config: ReportConfig, ctx: ReportContext): Promise<ReportOutput> {
  switch (config.type) {
    case 'daily_sales':
      return dailySales(config, ctx);
    case 'receivables':
    case 'payables':
      return outstanding(config, ctx);
    case 'stock_alerts':
      return stockAlerts(config, ctx);
    case 'cash_bank':
      return cashBank(config, ctx);
    case 'query_report':
      return queryReport(config, ctx);
  }
}

/** Should an "empty" result still be sent? */
function sendWhenEmpty(config: ReportConfig): boolean {
  if (config.type === 'stock_alerts' || config.type === 'query_report') return config.options.sendWhenEmpty;
  return true;
}

export interface RunResult {
  text: string;
  empty: boolean;
  attachmentName?: string;
  company: string;
  /** The WhatsApp number (account id) that sends it. */
  accountId: string | null;
  groups: string[];
  queued: number[];
  note?: string;
}

export class ReportScheduler {
  private jobs = new Map<string, Cron>();
  private readonly log: Logger;
  /** Time zone the current jobs were scheduled in. */
  timezone: string | null = null;

  constructor(
    private readonly deps: {
      db: Database;
      outbox: Outbox;
      erp: () => ErpNextClient;
      settings: () => Settings;
      context: ContextResolver;
      logger: Logger;
    },
  ) {
    this.log = deps.logger.child({ scope: 'reports' });
  }

  /** (Re)creates every cron job from the current settings. */
  reload(): void {
    this.stop();
    const settings = this.deps.settings();
    const timezone = this.deps.context.fallbackTimezone();
    this.timezone = timezone;
    for (const report of settings.reports.items) {
      if (!report.enabled) continue;
      try {
        const job = new Cron(report.schedule, { timezone, name: report.id, protect: true }, async () => {
          await this.run(report.id, 'schedule').catch(() => undefined);
        });
        this.jobs.set(report.id, job);
      } catch (error) {
        this.log.error(`Report "${reportTitle(report)}" has an invalid schedule "${report.schedule}": ${(error as Error).message}`);
      }
    }
    this.log.info(`Scheduled ${this.jobs.size} report(s) in time zone ${timezone}`);
  }

  stop(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  nextRuns(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const [id, job] of this.jobs) out[id] = job.nextRun()?.toISOString() ?? null;
    return out;
  }

  private async context(company: string): Promise<ReportContext> {
    const settings = this.deps.settings();
    const business = await this.deps.context.resolve(company);
    return {
      ...business,
      erp: this.deps.erp(),
      settings,
      today: todayInTz(business.timezone),
      fmt: makeFormatters(settings, business.currency),
    };
  }

  /** Builds a report without sending it (dashboard preview). */
  async preview(config: ReportConfig): Promise<ReportOutput> {
    return buildReport(config, await this.context(config.company));
  }

  /**
   * Builds a report and queues it for its groups.
   * @param idOrConfig a saved report id, or a full config (for "run now" on unsaved changes)
   */
  async run(idOrConfig: string | ReportConfig, trigger: 'schedule' | 'manual'): Promise<RunResult> {
    const settings = this.deps.settings();
    const config = typeof idOrConfig === 'string' ? settings.reports.items.find((r) => r.id === idOrConfig) : idOrConfig;
    if (!config) throw new Error(`Unknown report "${idOrConfig}"`);
    const title = reportTitle(config);
    const runId = this.deps.db.startReportRun(config.id, trigger);
    try {
      const ctx = await this.context(config.company);
      const output = await buildReport(config, ctx);
      // The company's profile decides which WhatsApp number sends it and the default groups.
      const profile = profileFor(settings, ctx.company);
      const groups = (config.groups.length ? config.groups : profile?.reportGroups ?? []).filter(Boolean);
      const result: RunResult = {
        text: output.text,
        empty: output.empty,
        attachmentName: output.attachment?.fileName,
        company: ctx.company,
        accountId: profile?.accountId ?? null,
        groups,
        queued: [],
      };

      if (output.empty && !sendWhenEmpty(config)) {
        result.note = 'Nothing to report, so nothing was sent.';
        this.deps.db.finishReportRun(runId, 'empty', result.note);
        this.log.info(`Report "${title}": nothing to report`);
        return result;
      }
      if (!profile) {
        result.note = `No WhatsApp number is set up for company "${ctx.company}" (Settings → Companies).`;
        this.deps.db.finishReportRun(runId, 'error', result.note);
        this.log.warn(`Report "${title}" was not sent: ${result.note}`);
        return result;
      }
      if (!groups.length) {
        result.note = 'No WhatsApp group selected for this report (Settings → Companies or the report itself).';
        this.deps.db.finishReportRun(runId, 'error', result.note);
        this.log.warn(`Report "${title}" was not sent: ${result.note}`);
        return result;
      }

      const attachmentId = output.attachment ? this.deps.db.addAttachment(output.attachment.fileName, output.attachment.mimetype, output.attachment.data) : null;
      for (const jid of groups) {
        const id = this.deps.outbox.enqueue({
          accountId: profile.accountId,
          kind: 'report',
          refDoctype: 'Report',
          refName: title,
          audience: 'group',
          recipient: jid,
          body: output.text,
          attachmentId,
          attachmentName: output.attachment?.fileName ?? null,
        });
        if (id) result.queued.push(id);
      }
      this.deps.db.finishReportRun(runId, output.empty ? 'empty' : 'ok', `queued for ${groups.length} group(s)`);
      this.log.info(`Report "${title}" queued for ${groups.length} group(s) (${trigger})`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.db.finishReportRun(runId, 'error', message);
      this.log.error(`Report "${title}" failed: ${message}`);
      throw error;
    }
  }
}
