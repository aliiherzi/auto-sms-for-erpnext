/** HTTP server: dashboard, JSON API and the ERPNext webhook endpoint. */
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { App } from '../app.js';
import { DATE_FORMATS } from '../util/time.js';
import { REPORT_TYPE_LABELS, ReportSchema, SettingsValidationError, type Settings } from '../config/settings.js';
import { ErpNextClient, ErpNextError } from '../erpnext/client.js';
import { isInvoiceDoctype } from '../invoices/service.js';
import { reportTitle } from '../reports/scheduler.js';
import { recentLogs } from '../util/logger.js';
import { isGroupJid, isJid, normalizePhone } from '../util/phone.js';
import { Auth, verifyFrappeSignature } from './auth.js';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function maskSettings(settings: Settings) {
  const copy = structuredClone(settings);
  const secretSet = Boolean(copy.erpnext.apiSecret);
  copy.erpnext.apiSecret = '';
  return { settings: copy, apiSecretSet: secretSet };
}

export function createServer(app: App) {
  const server = express();
  const auth = new Auth(app.env.ADMIN_PASSWORD, app.env.SESSION_SECRET);
  const log = app.logger.child({ scope: 'web' });
  if (app.env.TRUST_PROXY) server.set('trust proxy', 1);
  server.disable('x-powered-by');

  server.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  server.get('/healthz', (_req, res) => {
    res.json({ ok: true, whatsapp: app.whatsapp.getState().status, erpnext: app.lastErpCheck?.ok ?? false });
  });

  // -- ERPNext webhook (raw body needed for the signature) ---------------------
  let warnedNoSecret = false;
  server.post('/webhooks/erpnext', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const secret = app.env.WEBHOOK_SECRET;
    if (secret) {
      const signed = verifyFrappeSignature(raw, req.get('X-Frappe-Webhook-Signature'), secret);
      const tokenOk = req.query.token === secret;
      if (!signed && !tokenOk) {
        log.warn('Rejected a webhook call with a wrong or missing signature');
        res.status(401).json({ error: 'Invalid webhook signature' });
        return;
      }
    } else if (!warnedNoSecret) {
      warnedNoSecret = true;
      log.warn('WEBHOOK_SECRET is not set: webhook calls are accepted without a signature check.');
    }

    let data: Record<string, unknown> = {};
    const text = raw.toString('utf8');
    try {
      data = (req.get('content-type') || '').includes('json') || text.trim().startsWith('{') ? JSON.parse(text || '{}') : Object.fromEntries(new URLSearchParams(text));
    } catch {
      res.status(400).json({ error: 'Body must be JSON like {"doctype": "Sales Invoice", "name": "ACC-SINV-…"}' });
      return;
    }
    const doctype = data.doctype;
    const name = typeof data.name === 'string' ? data.name : '';
    if (!isInvoiceDoctype(doctype) || !name) {
      res.status(400).json({ error: 'Expected doctype "Sales Invoice" or "Purchase Invoice" and a document name' });
      return;
    }
    res.json({ ok: true });
    app.invoices.process(doctype, name, { source: 'webhook' }).catch((error) => log.warn(`Webhook for ${doctype} ${name} failed: ${(error as Error).message}`));
  });

  server.use(express.json({ limit: '1mb' }));

  // -- session ---------------------------------------------------------------
  server.get('/api/session', (req, res) => {
    res.json({ loggedIn: auth.isValid(req) });
  });

  server.post('/api/login', (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (auth.isLockedOut(ip)) {
      res.status(429).json({ error: 'Too many wrong passwords. Wait 5 minutes and try again.' });
      return;
    }
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!auth.checkPassword(password)) {
      auth.recordFailure(ip);
      res.status(401).json({ error: 'Wrong password' });
      return;
    }
    auth.clearFailures(ip);
    auth.issue(res, req.secure);
    res.json({ ok: true });
  });

  server.post('/api/logout', (_req, res) => {
    auth.clear(res);
    res.json({ ok: true });
  });

  const api = express.Router();
  api.use(auth.middleware());

  // -- status ----------------------------------------------------------------
  api.get('/status', async (req, res) => {
    if (req.query.check === '1' || !app.lastErpCheck) await app.refreshErpCheck();
    const settings = app.settings();
    const nextRuns = app.reports.nextRuns();
    const lastRuns = app.db.lastReportRuns();
    res.json({
      whatsapp: app.whatsapp.getState(),
      erpnext: { url: settings.erpnext.url, ...(app.lastErpCheck ?? { ok: false }) },
      testMode: settings.general.testMode,
      watcher: app.watcher.status(),
      counts: app.db.messageCounts(),
      reports: settings.reports.items.map((r) => ({
        id: r.id,
        title: reportTitle(r),
        type: r.type,
        enabled: r.enabled,
        schedule: r.schedule,
        groups: r.groups.length ? r.groups : settings.reports.defaultGroups,
        nextRun: nextRuns[r.id] ?? null,
        lastRun: lastRuns[r.id] ?? null,
      })),
      warnings: app.warnings(),
    });
  });

  api.get('/logs', (_req, res) => {
    res.json({ logs: recentLogs().slice(-200).reverse() });
  });

  // -- settings --------------------------------------------------------------
  api.get('/settings', (_req, res) => {
    res.json({
      ...maskSettings(app.settings()),
      locked: app.settingsStore.lockedFields(),
      reportTypes: REPORT_TYPE_LABELS,
      dateFormats: DATE_FORMATS,
      webhook: { path: '/webhooks/erpnext', secretSet: Boolean(app.env.WEBHOOK_SECRET) },
    });
  });

  api.put('/settings', (req, res) => {
    const incoming = req.body as Settings;
    if (!incoming || typeof incoming !== 'object') throw new HttpError(400, 'Settings must be a JSON object');
    const current = app.settingsStore.get();
    // An empty secret means "keep the one we have".
    if (incoming.erpnext && !incoming.erpnext.apiSecret) incoming.erpnext.apiSecret = current.erpnext.apiSecret;
    // Fields fixed by environment variables are not saved to the file.
    const locked = app.settingsStore.lockedFields();
    if (incoming.erpnext) {
      if (locked.includes('erpnext.url')) incoming.erpnext.url = '';
      if (locked.includes('erpnext.apiKey')) incoming.erpnext.apiKey = '';
      if (locked.includes('erpnext.apiSecret')) incoming.erpnext.apiSecret = '';
    }
    try {
      const saved = app.settingsStore.update(incoming);
      res.json({ ok: true, ...maskSettings(saved) });
    } catch (error) {
      if (error instanceof SettingsValidationError) throw new HttpError(400, error.message);
      throw error;
    }
  });

  // -- ERPNext ---------------------------------------------------------------
  api.post('/erpnext/test', async (req, res) => {
    const saved = app.settings().erpnext;
    const body = (req.body ?? {}) as { url?: string; apiKey?: string; apiSecret?: string };
    const client = new ErpNextClient({ url: body.url || saved.url, apiKey: body.apiKey || saved.apiKey, apiSecret: body.apiSecret || saved.apiSecret });
    const sameAsSaved = !body.url && !body.apiKey && !body.apiSecret;
    res.json(await app.refreshErpCheck(sameAsSaved ? app.erp() : client));
  });

  api.get('/erpnext/options', async (_req, res) => {
    const erp = app.erp();
    const safe = async <T>(fn: () => Promise<T>, fallback: T) => fn().catch(() => fallback);
    const [companies, salesFormats, purchaseFormats, letterheads, warehouses, accounts] = await Promise.all([
      safe(() => erp.getAll<{ name: string }>('Company', { fields: ['name'] }), []),
      safe(() => erp.getAll<{ name: string }>('Print Format', { fields: ['name'], filters: [['doc_type', '=', 'Sales Invoice'], ['disabled', '=', 0]] }), []),
      safe(() => erp.getAll<{ name: string }>('Print Format', { fields: ['name'], filters: [['doc_type', '=', 'Purchase Invoice'], ['disabled', '=', 0]] }), []),
      safe(() => erp.getAll<{ name: string }>('Letter Head', { fields: ['name'], filters: [['disabled', '=', 0]] }), []),
      safe(() => erp.getAll<{ name: string }>('Warehouse', { fields: ['name'], filters: [['is_group', '=', 0]] }), []),
      safe(() => erp.getAll<{ name: string }>('Account', { fields: ['name'], filters: [['account_type', 'in', ['Bank', 'Cash']], ['is_group', '=', 0]] }), []),
    ]);
    res.json({
      companies: companies.map((c) => c.name),
      printFormats: { sales: salesFormats.map((p) => p.name), purchase: purchaseFormats.map((p) => p.name) },
      letterheads: letterheads.map((l) => l.name),
      warehouses: warehouses.map((w) => w.name),
      accounts: accounts.map((a) => a.name),
    });
  });

  // -- WhatsApp --------------------------------------------------------------
  api.post('/whatsapp/link', async (_req, res) => {
    await app.whatsapp.startLinking();
    res.json(app.whatsapp.getState());
  });

  api.post('/whatsapp/pairing-code', async (req, res) => {
    const phone = String(req.body?.phone ?? '');
    const digits = normalizePhone(phone, app.settings().general.defaultCountryCode);
    if (!digits) throw new HttpError(400, 'Enter the WhatsApp number with its country code, e.g. +971501234567');
    const code = await app.whatsapp.requestPairingCode(digits);
    res.json({ code });
  });

  api.post('/whatsapp/logout', async (_req, res) => {
    await app.whatsapp.logout();
    res.json(app.whatsapp.getState());
  });

  api.get('/whatsapp/groups', async (req, res) => {
    if (!app.whatsapp.isConnected()) {
      res.json({ groups: [], connected: false });
      return;
    }
    res.json({ groups: await app.whatsapp.listGroups(req.query.refresh === '1'), connected: true });
  });

  // -- messages --------------------------------------------------------------
  api.get('/messages', (req, res) => {
    const q = req.query;
    res.json(
      app.db.listMessages({
        status: typeof q.status === 'string' && q.status ? q.status : undefined,
        kind: typeof q.kind === 'string' && q.kind ? q.kind : undefined,
        search: typeof q.search === 'string' && q.search ? q.search : undefined,
        limit: Math.min(200, Number(q.limit) || 50),
        offset: Number(q.offset) || 0,
      }),
    );
  });

  api.post('/messages/:id/retry', async (req, res) => {
    const id = Number(req.params.id);
    const message = app.db.getMessage(id);
    if (!message) throw new HttpError(404, 'Message not found');
    // An invoice message without a usable number: rebuild it from ERPNext (the contact may be fixed now).
    if (message.kind === 'invoice' && message.recipient === '-' && isInvoiceDoctype(message.ref_doctype) && message.ref_name) {
      const audience = message.audience === 'group' ? 'group' : 'party';
      const result = await app.invoices.process(message.ref_doctype, message.ref_name, { source: 'manual', force: true, only: [audience] });
      res.json({ ok: true, rebuilt: true, result });
      return;
    }
    if (!app.outbox.retry(id)) throw new HttpError(409, 'Only failed or skipped messages can be retried');
    res.json({ ok: true });
  });

  api.post('/test-message', (req, res) => {
    const to = String(req.body?.to ?? '').trim();
    const text = String(req.body?.text ?? '').trim() || '✅ Test message from Auto SMS for ERPNext';
    if (!to) throw new HttpError(400, 'Enter a phone number or choose a group');
    const recipient = isJid(to) || isGroupJid(to) ? to : normalizePhone(to, app.settings().general.defaultCountryCode);
    if (!recipient) throw new HttpError(400, `"${to}" is not a valid phone number. Use the international format, e.g. +971501234567`);
    const id = app.outbox.enqueue({ kind: 'test', audience: 'direct', recipient, body: text });
    res.json({ ok: true, id });
  });

  // -- reports ---------------------------------------------------------------
  const parseReport = (input: unknown) => {
    const parsed = ReportSchema.safeParse(input);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return parsed.data;
  };

  api.post('/reports/preview', async (req, res) => {
    const config = req.body?.report ? parseReport(req.body.report) : app.settings().reports.items.find((r) => r.id === req.body?.id);
    if (!config) throw new HttpError(404, 'Report not found');
    const output = await app.reports.preview(config);
    res.json({ text: output.text, empty: output.empty, attachmentName: output.attachment?.fileName ?? null });
  });

  api.post('/reports/run', async (req, res) => {
    const config = req.body?.report ? parseReport(req.body.report) : req.body?.id;
    if (!config) throw new HttpError(400, 'Which report?');
    res.json(await app.reports.run(config, 'manual'));
  });

  // -- invoices --------------------------------------------------------------
  api.post('/invoices/send', async (req, res) => {
    const doctype = req.body?.doctype;
    const name = String(req.body?.name ?? '').trim();
    if (!isInvoiceDoctype(doctype) || !name) throw new HttpError(400, 'Choose Sales Invoice or Purchase Invoice and enter the invoice number');
    const only = Array.isArray(req.body?.only) ? req.body.only.filter((x: string) => x === 'party' || x === 'group') : undefined;
    res.json(await app.invoices.process(doctype, name, { source: 'manual', force: true, only: only?.length ? only : undefined }));
  });

  api.post('/watcher/poll', async (_req, res) => {
    res.json(await app.watcher.pollOnce());
  });

  server.use('/api', api);

  // -- dashboard -------------------------------------------------------------
  server.use(express.static(publicDir, { index: 'index.html', maxAge: '1h' }));

  // -- errors ----------------------------------------------------------------
  server.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  server.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof ErpNextError) {
      res.status(502).json({ error: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if ((error as { type?: string })?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON' });
      return;
    }
    log.error({ err: error }, 'Request failed');
    res.status(500).json({ error: message });
  });

  return server;
}
