/** Wires all the parts together. Used by main.ts and by the tests. */
import path from 'node:path';
import type { Env } from './config/env.js';
import { SettingsStore, type Settings } from './config/settings.js';
import { Database } from './db/database.js';
import { ErpNextClient } from './erpnext/client.js';
import { ContextResolver } from './erpnext/context.js';
import { InvoiceService } from './invoices/service.js';
import { InvoiceWatcher } from './invoices/watcher.js';
import { Outbox } from './messaging/outbox.js';
import { ReportScheduler, reportTitle } from './reports/scheduler.js';
import type { Logger } from './util/logger.js';
import { BaileysWhatsApp } from './whatsapp/baileys.js';
import { FakeWhatsApp } from './whatsapp/fake.js';
import type { WhatsAppClient } from './whatsapp/types.js';

export interface ErpCheck {
  ok: boolean;
  at: string;
  user?: string;
  versions?: Record<string, string>;
  company?: string;
  timezone?: string;
  currency?: string;
  error?: string;
}

export interface AppOptions {
  whatsapp?: WhatsAppClient;
  fetchImpl?: typeof fetch;
  /** Don't start background loops (tests drive things by hand). */
  manual?: boolean;
}

export class App {
  readonly settingsStore: SettingsStore;
  readonly db: Database;
  readonly whatsapp: WhatsAppClient;
  readonly outbox: Outbox;
  readonly context: ContextResolver;
  readonly invoices: InvoiceService;
  readonly watcher: InvoiceWatcher;
  readonly reports: ReportScheduler;
  lastErpCheck: ErpCheck | null = null;
  private erpClient: ErpNextClient;
  private erpKey = '';
  private checkTimer?: NodeJS.Timeout;

  constructor(
    readonly env: Env,
    readonly logger: Logger,
    private readonly options: AppOptions = {},
  ) {
    this.settingsStore = new SettingsStore(env.DATA_DIR, {
      erpnextUrl: env.ERPNEXT_URL,
      erpnextApiKey: env.ERPNEXT_API_KEY,
      erpnextApiSecret: env.ERPNEXT_API_SECRET,
    });
    this.db = new Database(path.join(env.DATA_DIR, 'auto-sms.db'));
    this.whatsapp =
      options.whatsapp ??
      (env.WHATSAPP_DRIVER === 'fake'
        ? new FakeWhatsApp()
        : new BaileysWhatsApp({
            authDir: path.join(env.DATA_DIR, 'whatsapp-auth'),
            logger,
            proxyUrl: env.WHATSAPP_PROXY,
            libraryLogLevel: env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace' ? 'warn' : 'error',
          }));
    this.erpClient = this.makeErp();
    const settings = () => this.settings();
    const erp = () => this.erp();
    this.context = new ContextResolver(erp, settings);
    this.outbox = new Outbox({
      db: this.db,
      whatsapp: this.whatsapp,
      logger,
      delayMs: () => this.settings().general.sendDelaySeconds * 1000,
      countryCode: () => this.settings().general.defaultCountryCode,
    });
    this.invoices = new InvoiceService({ db: this.db, outbox: this.outbox, erp, settings, logger });
    this.watcher = new InvoiceWatcher({ db: this.db, service: this.invoices, erp, settings, context: this.context, logger });
    this.reports = new ReportScheduler({ db: this.db, outbox: this.outbox, erp, settings, context: this.context, logger });

    this.settingsStore.on('change', (next: Settings, previous: Settings) => {
      this.context.invalidate();
      if (next.erpnext.url !== previous.erpnext.url || next.erpnext.apiKey !== previous.erpnext.apiKey || next.erpnext.apiSecret !== previous.erpnext.apiSecret) {
        this.lastErpCheck = null;
      }
      if (!this.options.manual) {
        void this.refreshErpCheck().finally(() => this.reports.reload());
      }
    });
  }

  settings(): Settings {
    return this.settingsStore.get();
  }

  private makeErp(): ErpNextClient {
    const { url, apiKey, apiSecret } = this.settings().erpnext;
    this.erpKey = `${url}|${apiKey}|${apiSecret}`;
    return new ErpNextClient({ url, apiKey, apiSecret }, this.options.fetchImpl);
  }

  /** ERPNext client for the current settings (rebuilt automatically when they change). */
  erp(): ErpNextClient {
    const { url, apiKey, apiSecret } = this.settings().erpnext;
    if (`${url}|${apiKey}|${apiSecret}` !== this.erpKey) this.erpClient = this.makeErp();
    return this.erpClient;
  }

  /** Checks the ERPNext connection and remembers the answer for the dashboard. */
  async refreshErpCheck(client: ErpNextClient = this.erp()): Promise<ErpCheck> {
    const at = new Date().toISOString();
    if (!client.configured) {
      const result = { ok: false, at, error: 'Not configured yet' };
      if (client === this.erpClient) this.lastErpCheck = result;
      return result;
    }
    try {
      const user = await client.getLoggedUser();
      const versions = await client.getVersions();
      let result: ErpCheck = { ok: true, at, user, versions };
      if (client === this.erpClient) {
        this.context.invalidate();
        const ctx = await this.context.resolve();
        result = { ...result, company: ctx.company, timezone: ctx.timezone, currency: ctx.currency };
        this.lastErpCheck = result;
      }
      return result;
    } catch (error) {
      const result = { ok: false, at, error: error instanceof Error ? error.message : String(error) };
      if (client === this.erpClient) this.lastErpCheck = result;
      return result;
    }
  }

  async start(): Promise<void> {
    await this.refreshErpCheck();
    if (this.lastErpCheck?.ok) {
      this.logger.info(`ERPNext connected: ${this.settings().erpnext.url} as ${this.lastErpCheck.user} (company ${this.lastErpCheck.company})`);
    } else {
      this.logger.warn(`ERPNext not connected yet: ${this.lastErpCheck?.error}. Open the dashboard to set it up.`);
    }
    await this.whatsapp.start().catch((error) => this.logger.error({ err: error }, 'WhatsApp failed to start'));
    if (this.options.manual) return;
    this.outbox.start();
    this.watcher.start();
    this.reports.reload();
    this.checkTimer = setInterval(() => {
      void this.refreshErpCheck();
      this.db.pruneAttachments();
    }, 5 * 60_000);
    this.checkTimer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.checkTimer);
    this.watcher.stop();
    this.reports.stop();
    await this.outbox.stop();
    await this.whatsapp.stop();
    this.db.close();
  }

  /** Things the user should fix, in plain language. */
  warnings(): string[] {
    const s = this.settings();
    const out: string[] = [];
    if (!this.lastErpCheck?.ok) out.push('ERPNext is not connected. Go to Settings → ERPNext connection.');
    if (!this.whatsapp.isConnected()) out.push('WhatsApp is not linked. Link it on the Overview page.');
    if (s.general.testMode) out.push('Test mode is ON: invoices are not sent to customers/suppliers yet (Settings → General).');
    if (s.general.testMode && !s.general.testRecipient) out.push('Test mode has no test recipient, so customer/supplier messages are only logged.');
    if (!s.general.defaultCountryCode) out.push('Set the default country code (Settings → General) so local numbers like 05x… work.');
    const reportsWithoutGroup = s.reports.items.filter((r) => r.enabled && !r.groups.length && !s.reports.defaultGroups.length);
    if (reportsWithoutGroup.length) out.push(`Choose a WhatsApp group for reports (${reportsWithoutGroup.map(reportTitle).join(', ')}).`);
    if (s.invoices.purchase.enabled && !s.invoices.purchase.groups.length) out.push('Choose the internal WhatsApp group for supplier invoice copies (Settings → Supplier invoices).');
    return out;
  }
}
