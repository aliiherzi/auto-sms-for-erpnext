/** Any ERPNext query/script report, as a text table in the message or as a CSV attachment. */
import type { ReportConfig } from '../config/settings.js';
import type { ReportColumn } from '../erpnext/client.js';
import { safeFileName, toNumber, truncate } from '../util/format.js';
import { addDays, monthStart, weekStart, yearStart } from '../util/time.js';
import type { Formatters, ReportBuilder } from './types.js';

type QueryReportConfig = Extract<ReportConfig, { type: 'query_report' }>;

/** Replaces {{today}}, {{month_start}}… inside filter values. */
export function resolveFilterPlaceholders(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === 'string') {
    const exact = value.match(/^\{\{\s*(\w+)\s*\}\}$/);
    if (exact && exact[1] in vars) return vars[exact[1]];
    return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key: string) => (key in vars ? vars[key] : m));
  }
  if (Array.isArray(value)) return value.map((v) => resolveFilterPlaceholders(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveFilterPlaceholders(v, vars)]));
  }
  return value;
}

function cellText(value: unknown, column: ReportColumn, fmt: Formatters, currency: string): string {
  if (value === null || value === undefined || value === '') return '';
  switch (column.fieldtype) {
    case 'Currency':
      return fmt.money(value, currency).replace(/^[A-Z]{3}\s/, '');
    case 'Float':
    case 'Percent':
      return fmt.number(value);
    case 'Int':
      return fmt.number(value, 0);
    case 'Date':
      return fmt.date(String(value));
    default:
      return String(value).replace(/<[^>]+>/g, '').trim();
  }
}

function csvEscape(text: string): string {
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const queryReport: ReportBuilder<QueryReportConfig> = async (config, ctx) => {
  const { erp, fmt, today, company } = ctx;
  const reportName = config.options.reportName.trim();
  if (!reportName) throw new Error('Choose which ERPNext report to run (report name is empty).');

  const vars = {
    today,
    yesterday: addDays(today, -1),
    week_start: weekStart(today),
    month_start: monthStart(today),
    year_start: yearStart(today),
    company,
  };
  const filters = resolveFilterPlaceholders(config.options.filters, vars) as Record<string, unknown>;
  const result = await erp.runQueryReport(reportName, filters);

  const title = config.title || reportName;
  const header = [`📑 *${title}*`, `*${company}* · ${fmt.day(today)}`];
  const rows = result.rows.filter((row) => Object.values(row).some((v) => v !== null && v !== undefined && v !== ''));

  if (!rows.length) {
    return { text: [...header, '', result.message || 'The report returned no rows.'].join('\n'), empty: true };
  }

  if (config.options.output === 'csv') {
    const columns = result.columns;
    const csv = [
      columns.map((c) => csvEscape(c.label || c.fieldname)).join(','),
      ...rows.map((row) => columns.map((c) => csvEscape(row[c.fieldname] === null || row[c.fieldname] === undefined ? '' : String(row[c.fieldname]))).join(',')),
    ].join('\r\n');
    return {
      text: [...header, '', `${rows.length} row${rows.length === 1 ? '' : 's'} – see the attached file.`].join('\n'),
      attachment: { data: Buffer.from(`﻿${csv}`, 'utf8'), fileName: `${safeFileName(title)}-${today}.csv`, mimetype: 'text/csv' },
      empty: false,
    };
  }

  const totalRows = rows.filter(isTotalRow);
  const dataRows = rows.filter((row) => !isTotalRow(row));
  const columns = config.options.columns.length
    ? config.options.columns.map((name) => result.columns.find((c) => c.fieldname === name || c.label === name)).filter((c): c is ReportColumn => Boolean(c))
    : pickColumns(result.columns, dataRows);
  if (!columns.length) columns.push(...result.columns.slice(0, 4));

  const lines = [...header, ''];
  const shown = dataRows.slice(0, config.options.maxRows);
  const [first, ...rest] = columns;
  for (const row of shown) {
    const main = truncate(cellText(row[first.fieldname], first, fmt, ctx.currency) || '–', 45);
    const details = rest
      .map((c) => {
        const text = cellText(row[c.fieldname], c, fmt, ctx.currency);
        return text ? `${c.label}: ${truncate(text, 40)}` : '';
      })
      .filter(Boolean)
      .join(' · ');
    lines.push(`• *${main}*${details ? `\n    ${details}` : ''}`);
  }
  if (dataRows.length > shown.length) lines.push(`…and ${dataRows.length - shown.length} more rows`);

  // Totals: the report's own total row, or the sum of the numeric columns shown.
  const numeric = columns.filter((c) => NUMERIC.includes(c.fieldtype));
  if (numeric.length && (totalRows.length || dataRows.length > 1)) {
    const source = totalRows[totalRows.length - 1];
    const totals = numeric
      .map((c) => {
        const value = source ? source[c.fieldname] : dataRows.reduce((s, r) => s + toNumber(r[c.fieldname]), 0);
        return `${c.label}: ${cellText(value, c, fmt, ctx.currency)}`;
      })
      .join(' · ');
    lines.push('');
    lines.push(`*Total* – ${totals}`);
  }
  return { text: lines.join('\n'), empty: false };
};

const NUMERIC = ['Currency', 'Float', 'Int', 'Percent'];

function isTotalRow(row: Record<string, unknown>): boolean {
  return Object.values(row).some((v) => typeof v === 'string' && /^'?\s*total\s*'?$/i.test(v.trim()));
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === '' || value === 0;
}

/**
 * Picks the most useful columns for a phone screen: one label column followed by up to
 * three numeric columns, skipping columns that are empty, all zero, the same on every row,
 * or just repeat the label (e.g. customer_name next to customer).
 */
export function pickColumns(columns: ReportColumn[], rows: Record<string, unknown>[]): ReportColumn[] {
  const useful = columns.filter((c) => {
    if (!c.fieldname || /_type$/.test(c.fieldname)) return false;
    const values = rows.map((r) => r[c.fieldname]);
    if (values.every(isBlank)) return false;
    if (rows.length > 1 && new Set(values.map((v) => String(v ?? ''))).size === 1) return false;
    return true;
  });
  const label = useful.find((c) => !NUMERIC.includes(c.fieldtype));
  const numeric = useful.filter((c) => NUMERIC.includes(c.fieldtype));
  const sameAsLabel = (c: ReportColumn) => Boolean(label) && rows.every((r) => String(r[c.fieldname] ?? '') === String(r[label!.fieldname] ?? ''));
  const otherText = useful.filter((c) => c !== label && !NUMERIC.includes(c.fieldtype) && !sameAsLabel(c));
  const picked = [label, ...numeric.slice(0, 3)];
  if (numeric.length < 3) picked.push(...otherText.slice(0, 3 - numeric.length));
  return picked.filter((c): c is ReportColumn => Boolean(c));
}
