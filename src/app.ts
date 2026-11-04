/** Wires all the parts together. Used by main.ts and by the tests. */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Env } from './config/env.js';
import { profileFor, SettingsStore, type Settings, type WhatsAppAccount } from './config/settings.js';
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
import { WhatsAppManager } from './whatsapp/manager.js';
import type { WhatsAppClient } from './whatsapp/types.js';

export interface ErpCheck {
  ok: boolean;
  at: string;
  user?: string;
  versions?: Record<string, string>;
  company?: string;
  timezone?: string;
  currency?: string;
  companies?: string[];
  error?: string;
}

export interface AppOptions {
  /** Creates the WhatsApp connection for an account (tests pass fakes). */
  whatsappFactory?: (accountId: string) => WhatsAppClient;
  fetchImpl?: typeof fetch;
  /** Don't start background loops (tests drive things by hand). */
  manual?: boolean;
}

export class App {
  readonly settingsStore: SettingsStore;
  readonly db: Database;
  readonly whatsapp: WhatsAppManager;
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
    this.whatsapp = new WhatsAppManager(options.whatsappFactory ?? ((id) => this.createWhatsApp(id)), logger);
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
      void this.whatsapp.sync(next.whatsapp.accounts).then(() => this.outbox.sync());
      if (!this.options.manual) {
        void this.refreshErpCheck().finally(() => this.reports.reload());
      }
    });
  }

  private authDir(accountId: string): string {
    return path.join(this.env.DATA_DIR, 'whatsapp-auth', accountId);
  }

  private createWhatsApp(accountId: string): WhatsAppClient {
    if (this.env.WHATSAPP_DRIVER === 'fake') return new FakeWhatsApp();
    return new BaileysWhatsApp({
      authDir: this.authDir(accountId),
      logger: this.logger.child({ scope: accountId }),
      proxyUrl: this.env.WHATSAPP_PROXY,
      libraryLogLevel: this.env.LOG_LEVEL === 'debug' || this.env.LOG_LEVEL === 'trace' ? 'warn' : 'error',
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
        const companies = (await client.getAll<{ name: string }>('Company', { fields: ['name'] }).catch(() => [])).map((c) => c.name);
        result = { ...result, company: ctx.company, timezone: ctx.timezone, currency: ctx.currency, companies };
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
      this.logger.info(`ERPNext connected: ${this.settings().erpnext.url} as ${this.lastErpCheck.user} (default company ${this.lastErpCheck.company})`);
    } else {
      this.logger.warn(`ERPNext not connected yet: ${this.lastErpCheck?.error}. Open the dashboard to set it up.`);
    }
    await this.whatsapp.sync(this.settings().whatsapp.accounts);
    if (this.options.manual) return;
    this.outbox.start();
    this.watcher.start();
    this.reports.reload();
    let ticks = 0;
    this.checkTimer = setInterval(async () => {
      ticks++;
      // Check ERPNext every 5 minutes, or every minute while it can't be reached.
      if (!this.lastErpCheck?.ok || ticks % 5 === 0) await this.refreshErpCheck();
      // If ERPNext was unreachable at start-up, schedules began in the server's time zone:
      // move them to ERPNext's time zone as soon as it answers.
      if (this.reports.timezone !== this.context.fallbackTimezone()) this.reports.reload();
      if (ticks % 5 === 0) this.db.pruneAttachments();
    }, 60_000);
    this.checkTimer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.checkTimer);
    this.watcher.stop();
    this.reports.stop();
    await this.outbox.stop();
    await this.whatsapp.stopAll();
    this.db.close();
  }

  // -- WhatsApp numbers -------------------------------------------------------

  /** Adds a WhatsApp number (account) and starts its connection so it can be linked. */
  async addAccount(label: string): Promise<WhatsAppAccount> {
    const settings = this.settingsStore.get();
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'number';
    let id = base;
    for (let i = 2; settings.whatsapp.accounts.some((a) => a.id === id); i++) id = `${base}-${i}`;
    const account = { id, label: label.trim() || `Number ${settings.whatsapp.accounts.length + 1}` };
    settings.whatsapp.accounts.push(account);
    this.settingsStore.update(settings);
    await this.whatsapp.sync(this.settingsStore.get().whatsapp.accounts);
    this.outbox.sync();
    return account;
  }

  renameAccount(id: string, label: string): void {
    const settings = this.settingsStore.get();
    const account = settings.whatsapp.accounts.find((a) => a.id === id);
    if (!account) throw new Error('Unknown WhatsApp number');
    account.label = label.trim() || account.label;
    this.settingsStore.update(settings);
  }

  /** Removes a WhatsApp number: unlinks it, deletes its session and stops its connection. */
  async removeAccount(id: string): Promise<void> {
    const settings = this.settingsStore.get();
    if (!settings.whatsapp.accounts.some((a) => a.id === id)) throw new Error('Unknown WhatsApp number');
    if (settings.whatsapp.accounts.length === 1) throw new Error('Keep at least one WhatsApp number.');
    const users = settings.companies.filter((p) => p.accountId === id).map((p) => p.company || 'All other companies');
    if (users.length) throw new Error(`This number is used by: ${users.join(', ')}. Choose another number for them first (Settings → Companies).`);
    await this.whatsapp.unlink(id);
    settings.whatsapp.accounts = settings.whatsapp.accounts.filter((a) => a.id !== id);
    this.settingsStore.update(settings);
    await fs.rm(this.authDir(id), { recursive: true, force: true });
  }

  /** Things the user should fix, in plain language. */
  warnings(): string[] {
    const s = this.settings();
    const out: string[] = [];
    if (!this.lastErpCheck?.ok) out.push('ERPNext is not connected. Go to Settings → ERPNext connection.');
    for (const account of s.whatsapp.accounts) {
      if (!this.whatsapp.isConnected(account.id)) out.push(`WhatsApp number "${account.label || account.id}" is not linked. Link it on the Overview page.`);
    }
    if (s.general.testMode) out.push('Test mode is ON: invoices are not sent to customers/suppliers yet (Settings → General).');
    if (s.general.testMode && !s.general.testRecipient) out.push('Test mode has no test recipient, so customer/supplier messages are only logged.');
    if (!s.general.defaultCountryCode) out.push('Set the default country code (Settings → General) so local numbers like 05x… work.');

    const known = this.lastErpCheck?.companies ?? [];
    for (const profile of s.companies) {
      if (profile.company && known.length && !known.includes(profile.company)) out.push(`Company "${profile.company}" (Settings → Companies) does not exist in ERPNext.`);
    }
    for (const company of known) {
      if (!profileFor(s, company)) out.push(`Company "${company}" has no WhatsApp number, so its invoices are not sent (Settings → Companies).`);
    }
    const reportsWithoutGroup = s.reports.items.filter((r) => {
      if (!r.enabled || r.groups.length) return false;
      const profile = profileFor(s, r.company || this.lastErpCheck?.company || '');
      return !profile?.reportGroups.length;
    });
    if (reportsWithoutGroup.length) out.push(`Choose a WhatsApp group for reports (${reportsWithoutGroup.map(reportTitle).join(', ')}) in Settings → Companies.`);
    if (s.invoices.purchase.enabled && s.companies.some((p) => !p.purchaseGroups.length)) {
      out.push('Choose the internal WhatsApp group for supplier invoice copies (Settings → Companies).');
    }
    return out;
  }
}
