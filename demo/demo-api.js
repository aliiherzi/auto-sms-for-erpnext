// Demo backend: answers the dashboard's /api calls in the browser with sample data.
// Nothing is sent anywhere. Mirrors the real server's routes and answers.
(() => {
  const DATA = window.AUTO_SMS_DEMO_DATA;
  if (!DATA) return;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const nowIso = () => new Date().toISOString();

  let settings = clone(DATA.settings.settings);
  const meta = { reportTypes: DATA.settings.reportTypes, dateFormats: DATA.settings.dateFormats, webhook: DATA.settings.webhook };
  const accounts = clone(DATA.status.whatsapp);
  const groupsByAccount = clone(DATA.groups.accounts);
  const erpnext = { ...clone(DATA.status.erpnext), at: nowIso() };
  const watcher = clone(DATA.status.watcher);
  const lastRuns = Object.fromEntries(DATA.status.reports.map((r) => [r.id, r.lastRun]));
  let messages = clone(DATA.messages.rows);
  let nextId = Math.max(0, ...messages.map((m) => m.id)) + 1;
  const logs = clone(DATA.logs);
  const DEMO_GROUPS = [
    { id: '120363000000000101@g.us', name: 'Branch managers', size: 6, announce: false, isAdmin: true },
    { id: '120363000000000102@g.us', name: 'Branch accounts', size: 3, announce: false, isAdmin: true },
  ];

  const log = (level, message, scope = 'demo') => logs.unshift({ time: nowIso(), level, scope, message });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fail = (status, error) => json({ error }, status);
  const accountLabel = (id) => accounts.find((a) => a.id === id)?.label ?? id;
  const profileFor = (company) => settings.companies.find((p) => p.company && p.company === company) || settings.companies.find((p) => !p.company) || null;

  function reportTitle(r) {
    return r.title || (r.type === 'query_report' && r.options.reportName ? r.options.reportName : meta.reportTypes[r.type]);
  }

  /** Next time a 5-field cron expression fires, in the viewer's time zone. */
  function nextRun(expr) {
    const f = String(expr).trim().split(/\s+/);
    if (f.length !== 5) return null;
    const match = (field, value, min, max) =>
      field.split(',').some((part) => {
        const [range, stepText] = part.split('/');
        const step = Number(stepText || 1);
        let [a, b] = range === '*' ? [min, max] : range.split('-').map(Number);
        if (b === undefined) b = stepText ? max : a;
        return value >= a && value <= b && (value - a) % step === 0;
      });
    const d = new Date();
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() + 1);
    for (let i = 0; i < 60 * 24 * 40; i++) {
      if (match(f[0], d.getMinutes(), 0, 59) && match(f[1], d.getHours(), 0, 23) && match(f[2], d.getDate(), 1, 31) && match(f[3], d.getMonth() + 1, 1, 12) && match(f[4], d.getDay(), 0, 6)) {
        return d.toISOString();
      }
      d.setMinutes(d.getMinutes() + 1);
    }
    return null;
  }

  function counts() {
    const c = { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
    for (const m of messages) c[m.status] = (c[m.status] || 0) + 1;
    return c;
  }

  function warnings() {
    const out = [];
    for (const a of accounts) if (a.state.status !== 'connected') out.push(`WhatsApp number "${a.label}" is not linked. Link it on the Overview page.`);
    if (settings.general.testMode) out.push('Test mode is ON: invoices are not sent to customers/suppliers yet (Settings → General).');
    if (settings.general.testMode && !settings.general.testRecipient) out.push('Test mode has no test recipient, so customer/supplier messages are only logged.');
    if (!settings.general.defaultCountryCode) out.push('Set the default country code (Settings → General) so local numbers like 05x… work.');
    for (const company of erpnext.companies || []) if (!profileFor(company)) out.push(`Company "${company}" has no WhatsApp number, so its invoices are not sent (Settings → Companies).`);
    const noGroup = settings.reports.items.filter((r) => r.enabled && !r.groups.length && !(profileFor(r.company || erpnext.company)?.reportGroups.length));
    if (noGroup.length) out.push(`Choose a WhatsApp group for reports (${noGroup.map(reportTitle).join(', ')}) in Settings → Companies.`);
    return out;
  }

  function status() {
    return {
      whatsapp: clone(accounts),
      erpnext,
      companies: clone(settings.companies),
      testMode: settings.general.testMode,
      watcher: { ...watcher, lastPollAt: new Date(Date.now() - 20_000).toISOString() },
      counts: counts(),
      reports: settings.reports.items.map((r) => {
        const company = r.company || erpnext.company;
        const profile = profileFor(company);
        return {
          id: r.id,
          title: reportTitle(r),
          type: r.type,
          enabled: r.enabled,
          schedule: r.schedule,
          company,
          accountId: profile?.accountId ?? null,
          groups: r.groups.length ? r.groups : profile?.reportGroups ?? [],
          nextRun: r.enabled ? nextRun(r.schedule) : null,
          lastRun: lastRuns[r.id] ?? null,
        };
      }),
      warnings: warnings(),
    };
  }

  function addMessage(message) {
    const ts = nowIso();
    const row = { id: nextId++, kind: 'test', ref_doctype: null, ref_name: null, audience: 'direct', recipient_name: null, attachment_id: null, attachment_name: null, status: 'sent', error: null, attempts: 1, next_attempt_at: null, wa_message_id: `DEMO${nextId}`, dedupe_key: null, created_at: ts, updated_at: ts, sent_at: ts, ...message };
    messages.unshift(row);
    return row;
  }

  function preview(report) {
    const sample = DATA.previews[report.type] || DATA.previews.daily_sales;
    let text = sample.text;
    if (report.type === 'query_report' && report.options?.reportName) text = text.replace('Accounts Receivable Summary', report.options.reportName);
    if (report.title) text = text.replace(/\*[^*\n]+\*/, `*${report.title}*`);
    if (report.company && report.company !== erpnext.company) text = text.replaceAll(erpnext.company, report.company);
    return { text, empty: sample.empty, attachmentName: report.type === 'query_report' && report.options?.output === 'csv' ? 'report.csv' : null };
  }

  /** Simulates scanning the QR code a few seconds after linking starts. */
  function simulateLink(account) {
    setTimeout(() => {
      if (account.state.status !== 'waiting_for_scan') return;
      const phone = `9715${String(Math.floor(10000000 + Math.random() * 89999999))}`;
      account.state = { status: 'connected', driver: 'baileys', me: { id: `${phone}@s.whatsapp.net`, phone, name: account.label }, updatedAt: nowIso() };
      groupsByAccount[account.id] = { connected: true, groups: clone(DEMO_GROUPS) };
      log('info', `Connected to WhatsApp as +${phone}`, `${account.id}:whatsapp`);
    }, 9000);
  }

  function startLinking(account) {
    account.state = { status: 'waiting_for_scan', driver: 'baileys', qrDataUrl: DATA.qr, updatedAt: nowIso() };
    groupsByAccount[account.id] = { connected: false, groups: [] };
    simulateLink(account);
  }

  const routes = [
    ['GET', /^\/api\/session$/, () => json({ loggedIn: true })],
    ['POST', /^\/api\/login$/, () => json({ ok: true })],
    ['POST', /^\/api\/logout$/, () => json({ ok: true })],
    ['GET', /^\/api\/status$/, () => json(status())],
    ['GET', /^\/api\/logs$/, () => json({ logs })],
    ['GET', /^\/api\/settings$/, () => json({ ...meta, settings: clone(settings), apiSecretSet: true, locked: [] })],
    [
      'PUT',
      /^\/api\/settings$/,
      (body) => {
        const ids = new Set(accounts.map((a) => a.id));
        const bad = body.companies.find((p) => !ids.has(p.accountId));
        if (bad) return fail(400, `"${bad.company || 'All other companies'}" uses a WhatsApp number that doesn't exist (${bad.accountId})`);
        const seen = new Set();
        for (const p of body.companies) {
          if (seen.has(p.company)) return fail(400, `"${p.company || 'All other companies'}" is listed twice under Companies`);
          seen.add(p.company);
        }
        settings = clone(body);
        settings.erpnext.apiSecret = '';
        log('info', 'Settings saved', 'web');
        return json({ ok: true, settings: clone(settings), apiSecretSet: true });
      },
    ],
    ['POST', /^\/api\/erpnext\/test$/, () => json({ ok: true, at: nowIso(), user: erpnext.user, versions: erpnext.versions })],
    ['GET', /^\/api\/erpnext\/options$/, () => json(DATA.options)],
    [
      'POST',
      /^\/api\/whatsapp\/accounts$/,
      (body) => {
        const label = String(body?.label ?? '').trim();
        if (!label) return fail(400, 'Give the number a name, e.g. "Dubai branch"');
        const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'number';
        let id = base;
        for (let i = 2; accounts.some((a) => a.id === id); i++) id = `${base}-${i}`;
        const account = { id, label, state: {} };
        accounts.push(account);
        settings.whatsapp.accounts.push({ id, label });
        startLinking(account);
        log('info', `Added WhatsApp number "${label}"`, 'web');
        return json({ id, label });
      },
    ],
    [
      'PATCH',
      /^\/api\/whatsapp\/accounts\/([^/]+)$/,
      (body, [, id]) => {
        const account = accounts.find((a) => a.id === id);
        if (!account) return fail(404, 'Unknown WhatsApp number');
        account.label = String(body?.label ?? '').trim() || account.label;
        const saved = settings.whatsapp.accounts.find((a) => a.id === id);
        if (saved) saved.label = account.label;
        return json({ ok: true });
      },
    ],
    [
      'DELETE',
      /^\/api\/whatsapp\/accounts\/([^/]+)$/,
      (_body, [, id]) => {
        if (!accounts.some((a) => a.id === id)) return fail(404, 'Unknown WhatsApp number');
        if (accounts.length === 1) return fail(409, 'Keep at least one WhatsApp number.');
        const users = settings.companies.filter((p) => p.accountId === id).map((p) => p.company || 'All other companies');
        if (users.length) return fail(409, `This number is used by: ${users.join(', ')}. Choose another number for them first (Settings → Companies).`);
        accounts.splice(accounts.findIndex((a) => a.id === id), 1);
        settings.whatsapp.accounts = settings.whatsapp.accounts.filter((a) => a.id !== id);
        delete groupsByAccount[id];
        return json({ ok: true });
      },
    ],
    [
      'POST',
      /^\/api\/whatsapp\/accounts\/([^/]+)\/link$/,
      (_body, [, id]) => {
        const account = accounts.find((a) => a.id === id);
        if (!account) return fail(404, 'Unknown WhatsApp number');
        if (account.state.status !== 'connected') startLinking(account);
        return json(account.state);
      },
    ],
    [
      'POST',
      /^\/api\/whatsapp\/accounts\/([^/]+)\/pairing-code$/,
      (body, [, id]) => {
        const account = accounts.find((a) => a.id === id);
        if (!account) return fail(404, 'Unknown WhatsApp number');
        if (String(body?.phone ?? '').replace(/\D/g, '').length < 8) return fail(400, 'Enter the WhatsApp number with its country code, e.g. +971501234567');
        account.state = { ...account.state, pairingCode: 'K7PD-9QX2' };
        return json({ code: 'K7PD-9QX2' });
      },
    ],
    [
      'POST',
      /^\/api\/whatsapp\/accounts\/([^/]+)\/logout$/,
      (_body, [, id]) => {
        const account = accounts.find((a) => a.id === id);
        if (!account) return fail(404, 'Unknown WhatsApp number');
        account.state = { status: 'not_linked', driver: 'baileys', updatedAt: nowIso() };
        groupsByAccount[id] = { connected: false, groups: [] };
        log('info', `Unlinked "${account.label}"`, `${id}:whatsapp`);
        return json(account.state);
      },
    ],
    ['GET', /^\/api\/whatsapp\/groups$/, () => json({ accounts: clone(groupsByAccount) })],
    [
      'GET',
      /^\/api\/messages$/,
      (_body, _match, url) => {
        const q = url.searchParams;
        const search = (q.get('search') || '').toLowerCase();
        const rows = messages.filter(
          (m) =>
            (!q.get('status') || m.status === q.get('status')) &&
            (!q.get('kind') || m.kind === q.get('kind')) &&
            (!search || [m.ref_name, m.recipient, m.recipient_name, m.body].some((v) => String(v ?? '').toLowerCase().includes(search))),
        );
        const offset = Number(q.get('offset')) || 0;
        const limit = Number(q.get('limit')) || 50;
        return json({ rows: rows.slice(offset, offset + limit), total: rows.length });
      },
    ],
    [
      'POST',
      /^\/api\/messages\/(\d+)\/retry$/,
      (_body, [, id]) => {
        const m = messages.find((x) => x.id === Number(id));
        if (!m) return fail(404, 'Message not found');
        if (!['failed', 'skipped'].includes(m.status)) return fail(409, 'Only failed or skipped messages can be retried');
        if (m.recipient === '-') return fail(409, 'This customer still has no mobile number in ERPNext. Add one, then retry.');
        Object.assign(m, { status: 'sent', error: null, sent_at: nowIso(), updated_at: nowIso() });
        return json({ ok: true });
      },
    ],
    [
      'POST',
      /^\/api\/test-message$/,
      (body) => {
        const to = String(body?.to ?? '').trim();
        if (!to) return fail(400, 'Enter a phone number or choose a group');
        let recipient = to;
        if (!to.includes('@')) {
          let digits = to.replace(/\D/g, '');
          if (!to.startsWith('+') && digits.startsWith('0') && settings.general.defaultCountryCode) digits = settings.general.defaultCountryCode + digits.replace(/^0+/, '');
          if (digits.length < 8 || digits.length > 15) return fail(400, `"${to}" is not a valid phone number. Use the international format, e.g. +971501234567`);
          recipient = digits;
        }
        const row = addMessage({ account_id: body?.accountId || accounts[0].id, kind: 'test', audience: 'direct', recipient, body: String(body?.text ?? '').trim() || '✅ Test message from Auto SMS for ERPNext' });
        return json({ ok: true, id: row.id });
      },
    ],
    [
      'POST',
      /^\/api\/reports\/preview$/,
      (body) => {
        const report = body?.report || settings.reports.items.find((r) => r.id === body?.id);
        if (!report) return fail(404, 'Report not found');
        return json(preview(report));
      },
    ],
    [
      'POST',
      /^\/api\/reports\/run$/,
      (body) => {
        const report = body?.report || settings.reports.items.find((r) => r.id === body?.id);
        if (!report) return fail(400, 'Which report?');
        const company = report.company || erpnext.company;
        const profile = profileFor(company);
        const out = preview(report);
        const groups = report.groups.length ? report.groups : profile?.reportGroups ?? [];
        const result = { ...out, company, accountId: profile?.accountId ?? null, groups, queued: [] };
        if (!profile) result.note = `No WhatsApp number is set up for company "${company}" (Settings → Companies).`;
        else if (!groups.length) result.note = 'No WhatsApp group selected for this report (Settings → Companies or the report itself).';
        else for (const jid of groups) result.queued.push(addMessage({ account_id: profile.accountId, kind: 'report', ref_doctype: 'Report', ref_name: reportTitle(report), audience: 'group', recipient: jid, body: out.text }).id);
        lastRuns[report.id] = { id: nextId, report_id: report.id, trigger: 'manual', status: result.note ? 'error' : 'ok', detail: result.note ?? `queued for ${groups.length} group(s)`, started_at: nowIso(), finished_at: nowIso() };
        return json(result);
      },
    ],
    [
      'POST',
      /^\/api\/invoices\/send$/,
      (body) => {
        const name = String(body?.name ?? '').trim();
        if (!name) return fail(400, 'Choose Sales Invoice or Purchase Invoice and enter the invoice number');
        const sales = body.doctype === 'Sales Invoice';
        const party = sales ? 'Acme Trading' : 'Delta Supplies';
        const phone = sales ? '971501234567' : '971527654321';
        const profile = profileFor(erpnext.company);
        const only = body.only || ['party', 'group'];
        const text = sales
          ? `Dear ${party},\n\nPlease find attached your invoice *${name}*.\n\nAmount: *AED 777.00*\n\nThank you for your business.\n*${erpnext.company}*`
          : `Dear ${party},\n\nWe confirm that we have received and recorded your invoice.\n\nOur reference: ${name}\nAmount: *AED 420.00*\n\n*${erpnext.company}*`;
        const ref = { account_id: profile?.accountId || accounts[0].id, kind: 'invoice', ref_doctype: body.doctype, ref_name: name, attachment_name: `${name}.pdf` };
        let detail = '';
        if (only.includes('party')) {
          if (settings.general.testMode) {
            const target = settings.general.testRecipient.replace(/[^\d@.a-z]/g, '');
            addMessage({ ...ref, audience: 'test', recipient: target || '-', recipient_name: `Test recipient (instead of ${party})`, status: target ? 'sent' : 'skipped', error: target ? null : 'Test mode is on and no test recipient is set – message was only logged', body: `🧪 *TEST MODE* – this would be sent to ${party} (+${phone})\n\n${text}` });
            detail = `Test mode – not sent to the ${sales ? 'customer' : 'supplier'} (+${phone})`;
          } else {
            addMessage({ ...ref, audience: 'party', recipient: phone, recipient_name: party, body: text });
            detail = `Sent to the ${sales ? 'customer' : 'supplier'} on +${phone}`;
          }
        }
        const groups = only.includes('group') ? (sales ? profile?.salesGroups : profile?.purchaseGroups) ?? [] : [];
        for (const jid of groups) addMessage({ ...ref, audience: 'group', recipient: jid, body: `${sales ? '🧾' : '📥'} *New ${body.doctype}* ${name}\n${sales ? 'Customer' : 'Supplier'}: ${party}\n${detail}` });
        if (groups.length) detail += `${detail ? '; ' : ''}${groups.length} group(s)`;
        return json({ status: 'queued', detail: detail || 'nothing to send', messageIds: [] });
      },
    ],
    ['POST', /^\/api\/watcher\/poll$/, () => json({ checked: 3, processed: 0 })],
  ];

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;
    await new Promise((r) => setTimeout(r, 120)); // feel like a real server
    for (const [m, pattern, handler] of routes) {
      const match = url.pathname.match(pattern);
      if (m === method && match) return handler(body, match, url);
    }
    return fail(404, 'Not found');
  };
})();
