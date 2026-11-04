/** Balances of every Bank and Cash account (in each account's own currency). */
import type { ReportConfig } from '../config/settings.js';
import { ErpNextError, type ErpNextClient } from '../erpnext/client.js';
import { toNumber } from '../util/format.js';
import type { ReportBuilder } from './types.js';

type CashBankConfig = Extract<ReportConfig, { type: 'cash_bank' }>;

interface AccountRow {
  name: string;
  account_name: string;
  account_type: string;
  account_currency: string;
}

/**
 * Balances via ERPNext's standard "Account Balance" report (works on v13–v16 for
 * Accounts Users). Returns null when the report can't be used.
 */
async function balancesFromReport(erp: ErpNextClient, company: string, date: string): Promise<Map<string, number> | null> {
  try {
    const balances = new Map<string, number>();
    for (const accountType of ['Bank', 'Cash']) {
      const result = await erp.runQueryReport('Account Balance', { company, report_date: date, account_type: accountType });
      for (const row of result.rows) if (row.account) balances.set(String(row.account), toNumber(row.balance));
    }
    return balances;
  } catch {
    return null;
  }
}

export const cashBank: ReportBuilder<CashBankConfig> = async (config, ctx) => {
  const { erp, company, fmt, today } = ctx;
  const baseFilters: Array<[string, string, unknown]> = [
    ['company', '=', company],
    ['is_group', '=', 0],
    ['account_type', 'in', ['Bank', 'Cash']],
  ];
  let accounts: AccountRow[];
  try {
    accounts = await erp.getAll<AccountRow>('Account', {
      fields: ['name', 'account_name', 'account_type', 'account_currency'],
      filters: [...baseFilters, ['disabled', '=', 0]],
      orderBy: 'account_type asc, name asc',
    });
  } catch (error) {
    // very old versions have no "disabled" field on Account
    if (!(error instanceof ErpNextError)) throw error;
    accounts = await erp.getAll<AccountRow>('Account', {
      fields: ['name', 'account_name', 'account_type', 'account_currency'],
      filters: baseFilters,
      orderBy: 'account_type asc, name asc',
    });
  }
  if (config.options.accounts.length) {
    const wanted = new Set(config.options.accounts);
    accounts = accounts.filter((a) => wanted.has(a.name));
  }

  const lines = [`🏦 *${config.title || 'Cash & Bank Balances'}*`, `*${company}* · ${fmt.day(today)}`, ''];
  if (!accounts.length) {
    lines.push('No Bank or Cash accounts found (Chart of Accounts → Account Type "Bank"/"Cash").');
    return { text: lines.join('\n'), empty: true };
  }

  const fromReport = await balancesFromReport(erp, company, today);
  const totals = new Map<string, number>();
  let shown = 0;
  for (const account of accounts) {
    const balance = fromReport?.has(account.name) ? fromReport.get(account.name)! : await erp.getBalanceOn(account.name, today, company);
    if (config.options.hideZero && Math.abs(balance) < 0.005) continue;
    const currency = account.account_currency || ctx.currency;
    totals.set(currency, (totals.get(currency) ?? 0) + balance);
    lines.push(`${account.account_type === 'Cash' ? '💵' : '🏦'} ${account.account_name || account.name}: *${fmt.money(balance, currency)}*`);
    shown++;
  }
  if (!shown) lines.push('All balances are zero.');
  if (shown > 1 || totals.size > 1) {
    lines.push('');
    lines.push(`*Total:* ${[...totals.entries()].map(([cur, amount]) => fmt.money(amount, cur)).join(' · ')}`);
  }
  return { text: lines.join('\n'), empty: shown === 0 };
};
