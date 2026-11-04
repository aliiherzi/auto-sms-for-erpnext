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
  private cache = new Map<string, { value: BusinessContext; at: number }>();
  private lastTimezone?: string;

  constructor(
    private readonly erp: () => ErpNextClient,
    private readonly settings: () => Settings,
  ) {}

  invalidate(): void {
    this.cache.clear();
  }

  /** Time zone without asking ERPNext (used when ERPNext is unreachable and for schedules). */
  fallbackTimezone(): string {
    const configured = this.settings().general.timezone;
    if (isValidTimeZone(configured)) return configured;
    if (this.lastTimezone) return this.lastTimezone;
    const envTz = process.env.TZ;
    if (envTz && isValidTimeZone(envTz)) return envTz;
    // An empty TZ variable makes Node report "Etc/Unknown", which schedulers reject.
    const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return system && isValidTimeZone(system) ? system : 'UTC';
  }

  /**
   * @param company a specific ERPNext company, or empty for ERPNext's default company
   */
  async resolve(company = ''): Promise<BusinessContext> {
    const s = this.settings();
    const key = `${s.erpnext.url}|${company}|${s.general.timezone}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

    const erp = this.erp();
    const name = company || (await erp.getDefaultCompany()) || '';
    if (!name) throw new Error('No company found in ERPNext. Create a company or choose one in Settings.');
    const currency = await erp.getCompanyCurrency(name).catch(() => '');
    let timezone = s.general.timezone;
    if (!isValidTimeZone(timezone)) {
      const erpTz = await erp.getSystemTimeZone();
      timezone = erpTz && isValidTimeZone(erpTz) ? erpTz : this.fallbackTimezone();
    }
    this.lastTimezone = timezone;
    const value = { company: name, currency, timezone };
    this.cache.set(key, { value, at: Date.now() });
    return value;
  }
}
