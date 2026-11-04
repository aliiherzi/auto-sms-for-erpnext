/** Number and money formatting for WhatsApp messages. */

const precisionCache = new Map<string, number>();

/** Standard number of decimals for a currency (KWD → 3, JPY → 0, most → 2). */
export function currencyPrecision(currency: string): number {
  const code = (currency || '').toUpperCase();
  const cached = precisionCache.get(code);
  if (cached !== undefined) return cached;
  let digits = 2;
  try {
    digits = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    digits = 2;
  }
  precisionCache.set(code, digits);
  return digits;
}

export function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function formatNumber(value: unknown, locale = 'en-US', maxDecimals = 2, minDecimals = 0): string {
  const n = toNumber(value);
  try {
    return new Intl.NumberFormat(locale, { minimumFractionDigits: minDecimals, maximumFractionDigits: maxDecimals }).format(n);
  } catch {
    return n.toFixed(maxDecimals);
  }
}

/** "AED 1,250.00" — currency code first, so it reads the same in every locale. */
export function formatMoney(value: unknown, currency: string, locale = 'en-US'): string {
  const digits = currencyPrecision(currency);
  const amount = formatNumber(value, locale, digits, digits);
  return currency ? `${currency} ${amount}` : amount;
}

/** Shortens text to max characters, adding an ellipsis. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Removes HTML tags and decodes the most common entities (ERPNext messages often contain HTML). */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** Makes a safe file name out of a document name ("ACC-SINV/2026/001" → "ACC-SINV-2026-001"). */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'document';
}
