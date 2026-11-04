import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { App } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { silentLogger } from '../../src/util/logger.js';
import { FakeWhatsApp } from '../../src/whatsapp/fake.js';
import { createServer } from '../../src/web/server.js';

describe('dashboard API (no ERPNext needed)', () => {
  let app: App;
  let server: Server;
  let base = '';
  let cookie = '';
  let dataDir = '';
  const processed: Array<[string, string]> = [];

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asms-web-'));
    const env = loadEnv({ ADMIN_PASSWORD: 'web-test-password', DATA_DIR: dataDir, WEBHOOK_SECRET: 'hook-secret', WHATSAPP_DRIVER: 'fake' } as NodeJS.ProcessEnv, '/nonexistent');
    app = new App(env, silentLogger, { manual: true, whatsappFactory: () => new FakeWhatsApp() });
    await app.start();
    // Record webhook-triggered processing without talking to ERPNext.
    app.invoices.process = (async (doctype: string, name: string) => {
      processed.push([doctype, name]);
      return { status: 'queued', detail: '', messageIds: [] };
    }) as typeof app.invoices.process;
    server = createServer(app).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.close();
    await app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const json = (method: string, p: string, body?: unknown, auth = true) =>
    fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(auth && cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

  it('requires login', async () => {
    expect((await fetch(`${base}/api/status`)).status).toBe(401);
    expect((await json('POST', '/api/login', { password: 'nope' }, false)).status).toBe(401);
    const ok = await json('POST', '/api/login', { password: 'web-test-password' }, false);
    expect(ok.status).toBe(200);
    cookie = ok.headers.get('set-cookie')!.split(';')[0];
    expect(ok.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect((await json('GET', '/api/status')).status).toBe(200);
  });

  it('reports ERPNext as not configured and lists what to do', async () => {
    const status: any = await (await json('GET', '/api/status')).json();
    expect(status.erpnext.ok).toBe(false);
    expect(status.warnings.join(' ')).toMatch(/ERPNext is not connected/);
    expect(status.whatsapp).toHaveLength(1);
  });

  it('masks the API secret, keeps it when saving, and validates input', async () => {
    const first: any = await (await json('GET', '/api/settings')).json();
    first.settings.erpnext = { url: 'https://erp.example.com', apiKey: 'key', apiSecret: 'super-secret' };
    expect((await json('PUT', '/api/settings', first.settings)).status).toBe(200);
    const again: any = await (await json('GET', '/api/settings')).json();
    expect(again.settings.erpnext.apiSecret).toBe('');
    expect(again.apiSecretSet).toBe(true);
    // saving with an empty secret keeps the stored one
    again.settings.general.defaultCountryCode = '971';
    expect((await json('PUT', '/api/settings', again.settings)).status).toBe(200);
    expect(app.settings().erpnext.apiSecret).toBe('super-secret');
    expect(app.settings().general.defaultCountryCode).toBe('971');

    again.settings.companies[0].accountId = 'does-not-exist';
    const bad = await json('PUT', '/api/settings', again.settings);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toMatch(/WhatsApp number that doesn't exist/);
  });

  it('adds, renames and removes WhatsApp numbers', async () => {
    const added: any = await (await json('POST', '/api/whatsapp/accounts', { label: 'Sharjah Branch' })).json();
    expect(added).toEqual({ id: 'sharjah-branch', label: 'Sharjah Branch' });
    expect((await json('PATCH', '/api/whatsapp/accounts/sharjah-branch', { label: 'Sharjah' })).status).toBe(200);
    const status: any = await (await json('GET', '/api/status')).json();
    expect(status.whatsapp.map((a: any) => a.label)).toEqual(['Main number', 'Sharjah']);
    expect((await json('DELETE', '/api/whatsapp/accounts/sharjah-branch')).status).toBe(200);
    const last = await json('DELETE', '/api/whatsapp/accounts/main');
    expect(last.status).toBe(409);
  });

  it('queues test messages from a chosen number', async () => {
    const res: any = await (await json('POST', '/api/test-message', { accountId: 'main', to: '050 123 4567', text: 'hello' })).json();
    const row = app.db.getMessage(res.id)!;
    expect(row.recipient).toBe('971501234567');
    expect(row.account_id).toBe('main');
    expect((await json('POST', '/api/test-message', { accountId: 'nope', to: '+971501234567' })).status).toBe(404);
  });

  it('accepts only correctly signed ERPNext webhooks', async () => {
    const body = '{\n "doctype": "Sales Invoice",\n "name": "ACC-SINV-2026-00042"\n}';
    const signature = crypto.createHmac('sha256', 'hook-secret').update(body).digest('base64');
    const ok = await fetch(`${base}/webhooks/erpnext`, { method: 'POST', headers: { 'X-Frappe-Webhook-Signature': signature }, body });
    expect(ok.status).toBe(200);
    const bad = await fetch(`${base}/webhooks/erpnext`, { method: 'POST', headers: { 'X-Frappe-Webhook-Signature': 'AAAA' }, body });
    expect(bad.status).toBe(401);
    const wrongType = await fetch(`${base}/webhooks/erpnext?token=hook-secret`, { method: 'POST', body: JSON.stringify({ doctype: 'Item', name: 'X' }) });
    expect(wrongType.status).toBe(400);
    await new Promise((r) => setTimeout(r, 50));
    expect(processed).toEqual([['Sales Invoice', 'ACC-SINV-2026-00042']]);
  });

  it('serves the dashboard page', async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Auto SMS for ERPNext');
    expect((await fetch(`${base}/app.js`)).status).toBe(200);
    expect(((await (await fetch(`${base}/healthz`)).json()) as any).ok).toBe(true);
  });
});
