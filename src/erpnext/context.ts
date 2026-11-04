/** Resolves (and caches) company, company currency and time zone for reports and the watcher. */
import type { Settings } from '../config/settings.js';
import type { ErpNextClient } from './client.js';
import { isValidTimeZone } from '../util/time.js';

export interface BusinessContext {
  company: string;
  currency: string;
  timezone: string;
}

const TTL_MS = 10 * 60_000;

export class ContextResolver {
  private cached?: { key: string; value: BusinessContext; at: number };

  constructor(
    private readonly erp: () => ErpNextClient,
    private readonly settings: () => Settings,
  ) {}

  invalidate(): void {
    this.cached = undefined;
  }

  /** Time zone without asking ERPNext (used when ERPNext is unreachable). */
  fallbackTimezone(): string {
    const configured = this.settings().general.timezone;
    if (isValidTimeZone(configured)) return configured;
    if (this.cached) return this.cached.value.timezone;
    const envTz = process.env.TZ;
    if (envTz && isValidTimeZone(envTz)) return envTz;
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }

  async resolve(): Promise<BusinessContext> {
    const s = this.settings();
    const key = `${s.erpnext.url}|${s.general.company}|${s.general.timezone}`;
    if (this.cached && this.cached.key === key && Date.now() - this.cached.at < TTL_MS) return this.cached.value;

    const erp = this.erp();
    const company = s.general.company || (await erp.getDefaultCompany()) || '';
    if (!company) throw new Error('No company found in ERPNext. Create a company or choose one in Settings.');
    const currency = await erp.getCompanyCurrency(company).catch(() => '');
    let timezone = s.general.timezone;
    if (!isValidTimeZone(timezone)) {
      const erpTz = await erp.getSystemTimeZone();
      timezone = erpTz && isValidTimeZone(erpTz) ? erpTz : this.fallbackTimezone();
    }
    const value = { company, currency, timezone };
    this.cached = { key, value, at: Date.now() };
    return value;
  }
}
