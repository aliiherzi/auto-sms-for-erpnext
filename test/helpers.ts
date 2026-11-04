/** Test helpers: an in-memory stand-in for the ERPNext REST API. */
import type { ErpNextClient, Filter, ListOptions } from '../src/erpnext/client.js';
import { ErpNextError } from '../src/erpnext/client.js';

type Doc = Record<string, any>;

function compare(value: any, op: string, expected: any): boolean {
  switch (op) {
    case '=':
      return value == expected;
    case '!=':
      return value != expected;
    case '>':
      return value > expected;
    case '>=':
      return value >= expected;
    case '<':
      return value < expected;
    case '<=':
      return value <= expected;
    case 'in':
      return (expected as any[]).includes(value);
    case 'not in':
      return !(expected as any[]).includes(value);
    case 'like':
      return String(value ?? '').includes(String(expected).replace(/%/g, ''));
    default:
      throw new Error(`FakeErp: unsupported operator ${op}`);
  }
}

/**
 * Minimal fake of the parts of ErpNextClient the service uses.
 * Child-table filters are supported for Contact "Dynamic Link".
 */
export class FakeErp {
  docs = new Map<string, Map<string, Doc>>();
  pdfCalls: Array<{ doctype: string; name: string; options: any }> = [];
  failPdf = 0;
  configured = true;
  baseUrl = 'http://erp.test';
  private clock = 0;

  add(doctype: string, doc: Doc): Doc {
    if (!this.docs.has(doctype)) this.docs.set(doctype, new Map());
    const full: Doc = { docstatus: 0, modified: this.tick(), ...doc };
    this.docs.get(doctype)!.set(full.name, full);
    return full;
  }

  /** A fresh, increasing "modified" timestamp. */
  tick(): string {
    this.clock++;
    return `2026-11-04 10:00:${String(this.clock).padStart(2, '0')}.${String(this.clock).padStart(6, '0')}`;
  }

  touch(doctype: string, name: string, patch: Doc = {}): void {
    const doc = this.docs.get(doctype)!.get(name)!;
    Object.assign(doc, patch, { modified: this.tick() });
  }

  async getDoc<T = Doc>(doctype: string, name: string): Promise<T> {
    const doc = this.docs.get(doctype)?.get(name);
    if (!doc) throw new ErpNextError(`${doctype} ${name} not found`, 404, 'DoesNotExistError');
    return structuredClone(doc) as T;
  }

  async getList<T = Doc>(doctype: string, options: ListOptions = {}): Promise<T[]> {
    let rows = [...(this.docs.get(doctype)?.values() ?? [])];
    for (const filter of (options.filters ?? []) as Filter[]) {
      if (filter.length === 4) {
        const [child, field, op, value] = filter;
        if (child !== 'Dynamic Link') throw new Error('FakeErp: only Dynamic Link child filters');
        rows = rows.filter((r) => (r.links ?? []).some((l: Doc) => compare(l[field], op, value)));
      } else {
        const [field, op, value] = filter;
        rows = rows.filter((r) => compare(r[field], op, value));
      }
    }
    if (options.orderBy) {
      const [field, dir] = options.orderBy.split(/\s+/);
      rows.sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
    }
    const start = options.start ?? 0;
    const limit = options.limit ?? 20;
    rows = limit === 0 ? rows.slice(start) : rows.slice(start, start + limit);
    const fields = options.fields ?? ['name'];
    return rows.map((r) => Object.fromEntries(fields.map((f) => [f, r[f]]))) as T[];
  }

  async getAll<T = Doc>(doctype: string, options: Omit<ListOptions, 'limit' | 'start'> = {}): Promise<T[]> {
    return this.getList<T>(doctype, { ...options, start: 0, limit: 0 });
  }

  async downloadPdf(doctype: string, name: string, options: any = {}): Promise<Buffer> {
    this.pdfCalls.push({ doctype, name, options });
    if (this.failPdf > 0) {
      this.failPdf--;
      throw new ErpNextError('ERPNext could not create the PDF: Connection error', 500);
    }
    return Buffer.from(`%PDF-1.4 fake pdf for ${name}`);
  }

  async getDefaultCompany(): Promise<string> {
    return 'Demo Co';
  }

  async getCompanyCurrency(): Promise<string> {
    return 'AED';
  }

  async getSystemTimeZone(): Promise<string> {
    return 'Asia/Dubai';
  }

  asClient(): ErpNextClient {
    return this as unknown as ErpNextClient;
  }
}

/** Waits until fn() is truthy (polling), or throws after timeoutMs. */
export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 5000, intervalMs = 50): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
