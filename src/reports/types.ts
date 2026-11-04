import type { ReportConfig, Settings } from '../config/settings.js';
import type { ErpNextClient } from '../erpnext/client.js';
import type { BusinessContext } from '../erpnext/context.js';
import { formatMoney, formatNumber } from '../util/format.js';
import { formatDate, formatDayLabel, type DateFormat } from '../util/time.js';

export interface ReportAttachment {
  data: Buffer;
  fileName: string;
  mimetype: string;
}

export interface ReportOutput {
  text: string;
  attachment?: ReportAttachment;
  /** Nothing worth reporting (e.g. no low-stock items). */
  empty: boolean;
}

export interface ReportContext extends BusinessContext {
  erp: ErpNextClient;
  settings: Settings;
  /** 'YYYY-MM-DD' in the business time zone */
  today: string;
  fmt: Formatters;
}

export interface Formatters {
  money(value: unknown, currency?: string): string;
  number(value: unknown, decimals?: number): string;
  date(ymd: string | null | undefined): string;
  day(ymd: string): string;
  dateFormat: DateFormat;
}

export function makeFormatters(settings: Settings, companyCurrency: string): Formatters {
  const locale = settings.general.numberLocale;
  const dateFormat = settings.general.dateFormat;
  return {
    money: (value, currency) => formatMoney(value, currency ?? companyCurrency, locale),
    number: (value, decimals = 2) => formatNumber(value, locale, decimals),
    date: (ymd) => formatDate(ymd, dateFormat),
    day: (ymd) => formatDayLabel(ymd, dateFormat),
    dateFormat,
  };
}

export type ReportBuilder<T extends ReportConfig = ReportConfig> = (config: T, ctx: ReportContext) => Promise<ReportOutput>;
