/** Items at or below their re-order level (Item → Auto Re-order table in ERPNext). */
import type { ReportConfig } from '../config/settings.js';
import { toNumber, truncate } from '../util/format.js';
import type { ReportBuilder } from './types.js';

type StockAlertsConfig = Extract<ReportConfig, { type: 'stock_alerts' }>;

interface ReorderRow {
  parent: string;
  warehouse: string;
  warehouse_reorder_level: number;
  warehouse_reorder_qty: number;
}

interface BinRow {
  item_code: string;
  warehouse: string;
  actual_qty: number;
  projected_qty: number;
  ordered_qty: number;
  stock_uom: string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const stockAlerts: ReportBuilder<StockAlertsConfig> = async (config, ctx) => {
  const { erp, company, fmt, today } = ctx;
  const heading = `📦 *${config.title || 'Low Stock Alert'}*`;
  const subheading = `*${company}* · ${fmt.day(today)}`;

  const reorder = (
    await erp.getAll<ReorderRow>('Item Reorder', {
      parent: 'Item',
      fields: ['parent', 'warehouse', 'warehouse_reorder_level', 'warehouse_reorder_qty'],
      filters: [['warehouse_reorder_level', '>', 0]],
    })
  ).filter((r) => r.warehouse);

  if (!reorder.length) {
    return {
      text: [heading, subheading, '', 'No re-order levels are set up in ERPNext yet (Item → Inventory → Auto re-order).'].join('\n'),
      empty: true,
    };
  }

  // Only warehouses of this company (and the chosen ones, if any).
  const warehouses = await erp.getAll<{ name: string }>('Warehouse', { fields: ['name'], filters: [['company', '=', company]] });
  const allowed = new Set(warehouses.map((w) => w.name));
  const wanted = new Set(config.options.warehouses);
  const rules = reorder.filter((r) => allowed.has(r.warehouse) && (wanted.size === 0 || wanted.has(r.warehouse)));

  const itemCodes = [...new Set(rules.map((r) => r.parent))];
  const items = new Map<string, { item_name: string; stock_uom: string; disabled: number }>();
  const bins = new Map<string, BinRow>();
  for (const part of chunk(itemCodes, 150)) {
    for (const item of await erp.getAll<{ name: string; item_name: string; stock_uom: string; disabled: number }>('Item', {
      fields: ['name', 'item_name', 'stock_uom', 'disabled'],
      filters: [['name', 'in', part]],
    })) {
      items.set(item.name, item);
    }
    for (const bin of await erp.getAll<BinRow>('Bin', {
      fields: ['item_code', 'warehouse', 'actual_qty', 'projected_qty', 'ordered_qty', 'stock_uom'],
      filters: [['item_code', 'in', part]],
    })) {
      bins.set(`${bin.item_code}|${bin.warehouse}`, bin);
    }
  }

  const basedOn = config.options.basedOn;
  const alerts = rules
    .filter((r) => !toNumber(items.get(r.parent)?.disabled))
    .map((r) => {
      const bin = bins.get(`${r.parent}|${r.warehouse}`);
      const qty = toNumber(bin?.[basedOn]);
      const level = toNumber(r.warehouse_reorder_level);
      return {
        item: r.parent,
        name: items.get(r.parent)?.item_name || r.parent,
        uom: bin?.stock_uom || items.get(r.parent)?.stock_uom || '',
        warehouse: r.warehouse,
        qty,
        level,
        reorderQty: toNumber(r.warehouse_reorder_qty),
        ordered: toNumber(bin?.ordered_qty),
      };
    })
    .filter((a) => a.qty <= a.level)
    .sort((a, b) => a.qty / (a.level || 1) - b.qty / (b.level || 1));

  if (!alerts.length) {
    return { text: [heading, subheading, '', '✅ All items are above their re-order levels.'].join('\n'), empty: true };
  }

  const lines = [heading, subheading, '', `*${alerts.length}* item${alerts.length === 1 ? '' : 's'} at or below re-order level${basedOn === 'projected_qty' ? ' (projected stock)' : ''}:`, ''];
  for (const a of alerts.slice(0, config.options.maxItems)) {
    const out = a.qty <= 0 ? '🔴' : '🟠';
    lines.push(`${out} *${truncate(a.name, 40)}*${a.name !== a.item ? ` (${a.item})` : ''}`);
    let detail = `    ${a.warehouse}: ${fmt.number(a.qty)} ${a.uom} · re-order at ${fmt.number(a.level)}`;
    if (a.reorderQty) detail += `, order ${fmt.number(a.reorderQty)}`;
    if (a.ordered > 0) detail += ` · ${fmt.number(a.ordered)} on order`;
    lines.push(detail);
  }
  if (alerts.length > config.options.maxItems) lines.push(`…and ${alerts.length - config.options.maxItems} more`);
  return { text: lines.join('\n'), empty: false };
};
