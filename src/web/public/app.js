// Auto SMS for ERPNext – dashboard (no build step, no external libraries).

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);

/** Creates an element. Text children are always inserted as text (never HTML). */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'value') el.value = value;
    else if (key === 'checked') el.checked = Boolean(value);
    else if (key === 'selected') el.selected = Boolean(value);
    else if (key === 'disabled') el.disabled = Boolean(value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// ---------------------------------------------------------------------------
// where the server is
// ---------------------------------------------------------------------------
// Served by your server, the dashboard talks to the address it came from. As the app on
// GitHub Pages (AUTO_SMS_STATIC), it talks to the server you connect to, or runs the demo.
const STATIC = window.AUTO_SMS_STATIC === true;
const saved = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // private browsing: the app still works, it just won't remember the server
    }
  },
};
const DEMO = STATIC && saved.get('asms.mode') === 'demo';
let apiBase = STATIC && !DEMO ? saved.get('asms.server') || '' : '';
let token = STATIC && !DEMO ? saved.get('asms.token') : null;

async function api(path, { method = 'GET', body } = {}) {
  if (STATIC && !DEMO && !apiBase) {
    showLogin();
    throw new Error('Please log in');
  }
  const headers = body !== undefined ? { 'Content-Type': 'application/json' } : {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${apiBase}/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: apiBase ? 'omit' : 'same-origin',
    });
  } catch {
    throw new Error(apiBase ? `Can't reach your server at ${apiBase}. Check the address and that the server is running.` : "Can't reach the server.");
  }
  if (res.status === 401 && path !== '/login') {
    showLogin();
    throw new Error('Please log in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function toast(message, type = 'info') {
  const el = h('div', { class: `toast ${type}` }, message);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 8000 : 4000);
}

/** Runs an async action with the button disabled; shows errors as a toast. */
async function busy(button, fn) {
  const old = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = '…';
  }
  try {
    return await fn();
  } catch (error) {
    toast(error.message, 'error');
    return undefined;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = old;
    }
  }
}

/** In-page "are you sure?" dialog (window.confirm is blocked in some embedded browsers). */
function askConfirm(message, okLabel = 'OK') {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'ask' },
      h('p', {}, message),
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { onclick: () => { resolve(false); dialog.close(); } }, 'Cancel'),
        h('button', { class: 'primary', onclick: () => { resolve(true); dialog.close(); } }, okLabel),
      ),
    );
    dialog.addEventListener('close', () => { resolve(false); dialog.remove(); });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** In-page text input dialog (window.prompt is blocked in some embedded browsers). Resolves null on cancel. */
function askText(label, value = '', okLabel = 'Save') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', id: 'ask-text-input', value });
    const finish = (result) => { resolve(result); dialog.close(); };
    const dialog = h('dialog', { class: 'ask' },
      h('form', { onsubmit: (e) => { e.preventDefault(); finish(input.value.trim() || null); } },
        h('label', {}, label, input),
        h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:14px' },
          h('button', { type: 'button', onclick: () => finish(null) }, 'Cancel'),
          h('button', { type: 'submit', class: 'primary' }, okLabel),
        ),
      ),
    );
    dialog.addEventListener('close', () => { resolve(null); dialog.remove(); });
    document.body.append(dialog);
    dialog.showModal();
    input.select();
  });
}

function fmtTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function relTime(iso) {
  if (!iso) return '–';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

// ---------------------------------------------------------------------------
// schedules (cron <-> simple form)
// ---------------------------------------------------------------------------
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n) => String(n).padStart(2, '0');

function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return { freq: 'custom', cron: expr };
  const [m, hr, dom, mon, dow] = parts;
  if (!/^\d+$/.test(m) || !/^\d+$/.test(hr) || mon !== '*') return { freq: 'custom', cron: expr };
  const time = `${pad(hr)}:${pad(m)}`;
  if (dom === '*' && dow === '*') return { freq: 'daily', time };
  if (dom === '*' && dow === '1-5') return { freq: 'weekdays', time };
  if (dom === '*' && dow === '1-6') return { freq: 'mon-sat', time };
  if (dom === '*' && /^[0-6]$/.test(dow)) return { freq: 'weekly', time, dow: Number(dow) };
  if (/^\d+$/.test(dom) && dow === '*') return { freq: 'monthly', time, dom: Number(dom) };
  return { freq: 'custom', cron: expr };
}

function buildCron(s) {
  if (s.freq === 'custom') return s.cron;
  const [hh, mm] = (s.time || '20:00').split(':').map(Number);
  switch (s.freq) {
    case 'daily':
      return `${mm} ${hh} * * *`;
    case 'weekdays':
      return `${mm} ${hh} * * 1-5`;
    case 'mon-sat':
      return `${mm} ${hh} * * 1-6`;
    case 'weekly':
      return `${mm} ${hh} * * ${s.dow ?? 1}`;
    case 'monthly':
      return `${mm} ${hh} ${s.dom ?? 1} * *`;
    default:
      return s.cron;
  }
}

function describeCron(expr) {
  const s = parseCron(expr);
  switch (s.freq) {
    case 'daily':
      return `Every day at ${s.time}`;
    case 'weekdays':
      return `Monday–Friday at ${s.time}`;
    case 'mon-sat':
      return `Monday–Saturday at ${s.time}`;
    case 'weekly':
      return `Every ${WEEKDAYS[s.dow]} at ${s.time}`;
    case 'monthly':
      return `Monthly on day ${s.dom} at ${s.time}`;
    default:
      return `Custom: ${expr}`;
  }
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const state = {
  status: null,
  settingsResponse: null,
  draft: null, // settings being edited
  dirty: false,
  groupsByAccount: {}, // { [accountId]: { connected, groups: [...] } }
  options: null,
  tab: 'overview',
  pairingPhone: {},
  activity: { status: '', kind: '', search: '', offset: 0, rows: [], total: 0 },
};
let statusTimer;

/** Linked WhatsApp numbers with their live state: [{ id, label, state }] */
const accounts = () => state.status?.whatsapp ?? [];
const accountLabel = (id) => accounts().find((a) => a.id === id)?.label ?? id;
const groupsOf = (accountId) => state.groupsByAccount[accountId]?.groups ?? [];
const allGroups = () => Object.entries(state.groupsByAccount).flatMap(([accountId, v]) => v.groups.map((g) => ({ ...g, accountId })));
const defaultCompany = () => state.status?.erpnext?.company || '';

function groupName(jid) {
  const g = allGroups().find((x) => x.id === jid);
  return g ? g.name : jid;
}

/** Same rule as the server: the company's own entry, else the catch-all entry. */
function profileFor(profiles, company) {
  return profiles.find((p) => p.company && p.company === company) || profiles.find((p) => !p.company) || null;
}

// ---------------------------------------------------------------------------
// login / shell
// ---------------------------------------------------------------------------
function showLogin() {
  $('#shell').classList.add('hidden');
  clearTimeout(statusTimer);
  if (STATIC) {
    $('#welcome').classList.remove('hidden');
    const url = $('#connect-url');
    if (!url.value) url.value = saved.get('asms.server') || '';
    setTimeout(() => (url.value ? $('#connect-password') : url).focus(), 50);
    return;
  }
  $('#login').classList.remove('hidden');
  setTimeout(() => $('#login-password').focus(), 50);
}

async function showShell() {
  $('#login').classList.add('hidden');
  $('#welcome').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  await refreshStatus();
  await loadGroups();
  switchTab(tabFromHash());
}

/** Tab names in the address bar (#setup for Settings). */
const TAB_HASH = { overview: 'overview', settings: 'setup', activity: 'activity', tools: 'tools', logs: 'logs' };
function tabFromHash() {
  const hash = location.hash.replace('#', '');
  return Object.keys(TAB_HASH).find((tab) => TAB_HASH[tab] === hash) || 'overview';
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/login', { method: 'POST', body: { password: $('#login-password').value } });
    $('#login-password').value = '';
    await showShell();
  } catch (error) {
    $('#login-error').textContent = error.message;
  }
});

$('#logout').addEventListener('click', async () => {
  if (DEMO) {
    saved.set('asms.mode', null);
    location.reload();
    return;
  }
  await api('/logout', { method: 'POST' }).catch(() => undefined);
  if (STATIC) {
    token = null;
    saved.set('asms.token', null);
  }
  showLogin();
});

// The app on GitHub Pages: connect to your own server…
$('#connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('#connect-error');
  error.textContent = '';
  let url = $('#connect-url').value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url);
  if (location.protocol === 'https:' && url.startsWith('http://') && !local) {
    error.textContent = 'Use the https:// address of your server: phones and browsers block plain http:// from this app. (README → "Your own web address")';
    return;
  }
  const button = event.submitter;
  if (button) button.disabled = true;
  apiBase = url;
  token = null;
  try {
    const session = await api('/session');
    if (session.app !== 'auto-sms-for-erpnext') throw new Error('That address is not an Auto SMS server.');
    const result = await api('/login', { method: 'POST', body: { password: $('#connect-password').value } });
    token = result.token;
    saved.set('asms.server', apiBase);
    saved.set('asms.token', token);
    saved.set('asms.mode', 'server');
    $('#connect-password').value = '';
    await showShell();
  } catch (e) {
    error.textContent = e.message === 'Please log in' ? 'Wrong password.' : e.message;
  } finally {
    if (button) button.disabled = false;
  }
});

// …or look around with sample data.
$('#try-demo').addEventListener('click', () => {
  saved.set('asms.mode', 'demo');
  location.reload();
});
$('#leave-demo').addEventListener('click', () => {
  saved.set('asms.mode', null);
  location.reload();
});

$('#tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('button')?.dataset.tab;
  if (tab) switchTab(tab);
});

window.addEventListener('beforeunload', (event) => {
  if (state.dirty) event.preventDefault();
});

window.addEventListener('hashchange', () => {
  const tab = tabFromHash();
  if (tab !== state.tab) switchTab(tab);
});

function switchTab(tab) {
  if (!['overview', 'settings', 'activity', 'tools', 'logs'].includes(tab)) tab = 'overview';
  state.tab = tab;
  try {
    history.replaceState(null, '', `#${TAB_HASH[tab]}`);
  } catch {
    // some embedded browsers don't allow it; the tab still switches
  }
  for (const btn of document.querySelectorAll('#tabs button')) btn.classList.toggle('active', btn.dataset.tab === tab);
  for (const section of document.querySelectorAll('.tab')) section.classList.toggle('hidden', section.id !== `tab-${tab}`);
  ({ overview: renderOverview, settings: renderSettings, activity: renderActivity, tools: renderTools, logs: renderLogs })[tab]();
}

// ---------------------------------------------------------------------------
// status polling
// ---------------------------------------------------------------------------
async function refreshStatus(check = false) {
  clearTimeout(statusTimer);
  try {
    const before = JSON.stringify(accounts().map((a) => [a.id, a.state.status]));
    state.status = await api(`/status${check ? '?check=1' : ''}`);
    renderPills();
    if (before !== JSON.stringify(accounts().map((a) => [a.id, a.state.status]))) await loadGroups();
    if (state.tab === 'overview') renderOverview();
  } catch (error) {
    if (error.message !== 'Please log in') toast(error.message, 'error');
  }
  const linking = accounts().some((a) => ['waiting_for_scan', 'connecting', 'reconnecting'].includes(a.state.status));
  statusTimer = setTimeout(refreshStatus, linking ? 2500 : 15000);
}

async function loadGroups(refresh = false) {
  try {
    state.groupsByAccount = (await api(`/whatsapp/groups${refresh ? '?refresh=1' : ''}`)).accounts;
  } catch {
    state.groupsByAccount = {};
  }
}

function renderPills() {
  const s = state.status;
  const pills = $('#pills');
  pills.replaceChildren();
  if (!s) return;
  const list = accounts();
  const connected = list.filter((a) => a.state.status === 'connected').length;
  const waText = list.length === 1 ? (connected ? 'WhatsApp connected' : 'WhatsApp not linked') : `WhatsApp ${connected}/${list.length} connected`;
  pills.append(h('span', { class: `pill ${connected === list.length ? 'ok' : connected === 0 ? 'bad' : 'warn'}` }, waText));
  pills.append(h('span', { class: `pill ${s.erpnext.ok ? 'ok' : 'bad'}` }, s.erpnext.ok ? 'ERPNext connected' : 'ERPNext not connected'));
  if (s.testMode) pills.append(h('span', { class: 'pill warn' }, 'Test mode'));
}

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------
let overviewSignature = '';

function renderOverview() {
  const root = $('#tab-overview');
  const s = state.status;
  if (!s) return;
  // Only redraw when something visible changed (keeps half-typed input intact).
  const signature = JSON.stringify({
    ...s,
    whatsapp: s.whatsapp.map((a) => ({ ...a, state: { ...a.state, updatedAt: '' } })),
    erpnext: { ...s.erpnext, at: '' },
    groups: allGroups().length,
  });
  if (signature === overviewSignature && root.childElementCount) return;
  overviewSignature = signature;
  const focusedId = document.activeElement?.id?.startsWith('pairing-phone-') ? document.activeElement.id : null;
  const children = [];
  if (s.warnings.length) {
    children.push(h('div', { class: 'notice' }, h('strong', {}, 'To do'), h('ul', {}, s.warnings.map((w) => h('li', {}, w)))));
  }
  children.push(h('div', { class: 'grid' }, accounts().map(whatsappCard), addAccountCard()));
  children.push(h('div', { class: 'grid' }, erpnextCard(s.erpnext), invoicesCard(s)));
  children.push(reportsCard(s.reports));
  root.replaceChildren(h('div', { class: 'stack' }, children));
  if (focusedId) document.getElementById(focusedId)?.focus();
}

function whatsappCard(account) {
  const wa = account.state;
  const base = `/whatsapp/accounts/${encodeURIComponent(account.id)}`;
  const companies = (state.status.companies || []).filter((p) => p.accountId === account.id).map((p) => p.company || 'All other companies');
  const body = [];
  if (wa.driver === 'fake') body.push(h('p', { class: 'notice info small' }, 'Test driver (WHATSAPP_DRIVER=fake): nothing is really sent.'));
  body.push(h('p', { class: 'muted small' }, companies.length ? `Used by: ${companies.join(', ')}` : 'Not used by any company yet (Settings → Companies).'));

  if (wa.status === 'connected') {
    body.push(
      h('dl', { class: 'kv' }, h('dt', {}, 'Linked number'), h('dd', {}, `+${wa.me?.phone || ''}`), h('dt', {}, 'Name'), h('dd', {}, wa.me?.name || '–'), h('dt', {}, 'Groups'), h('dd', {}, String(groupsOf(account.id).length))),
      h('div', { class: 'row', style: 'margin-top:14px' },
        h('button', { onclick: (e) => busy(e.currentTarget, async () => { await loadGroups(true); toast(`${groupsOf(account.id).length} group(s) loaded`); overviewSignature = ''; renderOverview(); }) }, 'Reload groups'),
        h('button', {
          class: 'danger',
          onclick: async (e) => {
            const button = e.currentTarget;
            if (!(await askConfirm(`Unlink "${account.label}"? You will have to scan a QR code again.`, 'Unlink'))) return;
            busy(button, async () => {
              await api(`${base}/logout`, { method: 'POST' });
              await refreshStatus();
            });
          },
        }, 'Unlink'),
      ),
    );
  } else if (wa.status === 'waiting_for_scan') {
    body.push(
      h('div', { class: 'qr-wrap' },
        wa.qrDataUrl ? h('img', { class: 'qr', src: wa.qrDataUrl, alt: `WhatsApp QR code for ${account.label}` }) : null,
        h('div', {},
          h('ol', { class: 'steps' }, h('li', {}, `Open WhatsApp on the phone of the number for "${account.label}".`), h('li', {}, 'Tap Settings (or ⋮) → Linked devices → Link a device.'), h('li', {}, 'Point the phone at this QR code.')),
          h('p', { class: 'muted small' }, 'The code refreshes automatically. A dedicated business number is safest.'),
        ),
      ),
      pairingForm(account),
    );
  } else if (['connecting', 'reconnecting'].includes(wa.status)) {
    body.push(h('p', {}, wa.status === 'connecting' ? 'Connecting to WhatsApp…' : 'Connection lost, reconnecting…'), wa.lastError ? h('p', { class: 'muted small' }, wa.lastError) : null);
  } else {
    body.push(
      h('p', {}, wa.status === 'error' ? 'This number needs attention.' : 'Not linked yet.'),
      wa.lastError ? h('p', { class: 'error-text' }, wa.lastError) : null,
      h('button', {
        class: 'primary',
        onclick: (e) =>
          busy(e.currentTarget, async () => {
            await api(`${base}/link`, { method: 'POST' });
            await refreshStatus();
          }),
      }, wa.status === 'error' ? 'Reconnect' : 'Link this number'),
    );
  }

  const rename = h('button', {
    class: 'small ghost',
    onclick: async (e) => {
      const button = e.currentTarget;
      const label = await askText('Name for this WhatsApp number', account.label);
      if (label && label !== account.label) {
        busy(button, async () => {
          await api(base, { method: 'PATCH', body: { label } });
          await refreshStatus();
        });
      }
    },
  }, 'Rename');
  const remove = accounts().length > 1
    ? h('button', {
        class: 'small ghost danger',
        onclick: async (e) => {
          const button = e.currentTarget;
          if (!(await askConfirm(`Remove "${account.label}"? It is unlinked from WhatsApp and its waiting messages are cancelled.`, 'Remove'))) return;
          busy(button, async () => {
            await api(base, { method: 'DELETE' });
            toast('Number removed');
            state.draft = null;
            await refreshStatus();
          });
        },
      }, 'Remove')
    : null;
  return h('div', { class: 'card' }, h('h2', {}, `📱 ${account.label}`, h('span', { class: 'spacer' }), rename, remove), body);
}

function addAccountCard() {
  const input = h('input', { type: 'text', placeholder: 'e.g. Dubai branch' });
  return h('div', { class: 'card' },
    h('h2', {}, '➕ Add another WhatsApp number'),
    h('p', { class: 'muted small' }, 'Add one number per company or branch. Link it with its own QR code, then choose which company uses it in Settings → Companies.'),
    field('Name', null, input),
    h('div', { class: 'row', style: 'margin-top:12px' }, h('button', {
      class: 'primary',
      onclick: (e) => busy(e.currentTarget, async () => {
        const account = await api('/whatsapp/accounts', { method: 'POST', body: { label: input.value } });
        toast(`"${account.label}" added – now link it`);
        state.draft = null;
        await refreshStatus();
      }),
    }, 'Add number')),
  );
}

function pairingForm(account) {
  const wa = account.state;
  const input = h('input', {
    id: `pairing-phone-${account.id}`,
    type: 'text',
    placeholder: '+971 50 123 4567',
    inputmode: 'tel',
    autocomplete: 'tel',
    value: state.pairingPhone[account.id] || '',
    oninput: (e) => (state.pairingPhone[account.id] = e.target.value),
  });
  const result = h('div', {});
  if (wa.pairingCode) {
    result.append(
      h('p', { class: 'small' }, 'In WhatsApp: Linked devices → Link a device → "Link with phone number instead", then type:'),
      h('div', { class: 'pairing-code' }, wa.pairingCode),
    );
  }
  return h(
    'details',
    { open: wa.pairingCode ? true : undefined },
    h('summary', {}, 'Can’t scan? Link with phone number instead'),
    h('label', {}, 'WhatsApp number to link', h('span', { class: 'hint' }, 'With country code. You will get an 8-character code to type in WhatsApp.'), input),
    h('div', { class: 'row', style: 'margin-top:8px' }, h('button', {
      onclick: (e) =>
        busy(e.currentTarget, async () => {
          const { code } = await api(`/whatsapp/accounts/${encodeURIComponent(account.id)}/pairing-code`, { method: 'POST', body: { phone: input.value } });
          toast(`Pairing code: ${code}`);
          await refreshStatus();
        }),
    }, 'Get pairing code')),
    result,
  );
}

function erpnextCard(erp) {
  const body = [];
  if (erp.ok) {
    body.push(
      h(
        'dl',
        { class: 'kv' },
        h('dt', {}, 'Site'), h('dd', {}, erp.url),
        h('dt', {}, 'API user'), h('dd', {}, erp.user || '–'),
        h('dt', {}, 'Companies'), h('dd', {}, (erp.companies || []).join(', ') || erp.company || '–'),
        h('dt', {}, 'Default company'), h('dd', {}, erp.company || '–'),
        h('dt', {}, 'Time zone'), h('dd', {}, erp.timezone || '–'),
        h('dt', {}, 'Version'), h('dd', {}, Object.entries(erp.versions || {}).map(([app, v]) => `${app} ${v}`).join(', ') || '–'),
      ),
    );
  } else {
    body.push(h('p', { class: 'error-text' }, erp.error || 'Not connected'), h('button', { onclick: () => switchTab('settings') }, 'Open settings'));
  }
  body.push(
    h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { onclick: (e) => busy(e.currentTarget, () => refreshStatus(true)) }, 'Check again'), h('span', { class: 'muted small' }, `Checked ${relTime(erp.at)}`)),
  );
  return h('div', { class: 'card' }, h('h2', {}, 'ERPNext'), body);
}

function invoicesCard(s) {
  const w = s.watcher;
  return h(
    'div',
    { class: 'card' },
    h('h2', {}, 'Invoices & messages'),
    h(
      'dl',
      { class: 'kv' },
      ...w.watching.flatMap((d) => [h('dt', {}, d.doctype), h('dd', {}, d.since ? `watching (from ${d.since})` : 'starting…')]),
      h('dt', {}, 'Last check'), h('dd', {}, w.lastPollAt ? relTime(w.lastPollAt) : '–'),
      h('dt', {}, 'Sent'), h('dd', {}, String(s.counts.sent)),
      h('dt', {}, 'Waiting'), h('dd', {}, String(s.counts.queued + s.counts.sending)),
      h('dt', {}, 'Failed'), h('dd', {}, s.counts.failed ? h('a', { href: '#activity', onclick: () => { state.activity.status = 'failed'; } }, String(s.counts.failed)) : '0'),
    ),
    w.lastError ? h('p', { class: 'error-text small' }, w.lastError) : null,
  );
}

function reportsCard(reports) {
  const many = accounts().length > 1;
  const rows = reports.map((r) =>
    h(
      'tr',
      {},
      h('td', {}, h('strong', {}, r.title), h('div', { class: 'muted small' }, r.company || ''), r.enabled ? null : h('div', { class: 'muted small' }, 'off')),
      h('td', {}, describeCron(r.schedule), r.nextRun ? h('div', { class: 'muted small' }, `next ${relTime(r.nextRun)}`) : null),
      h('td', {},
        many && r.accountId ? h('div', { class: 'muted small' }, `from ${accountLabel(r.accountId)}`) : null,
        r.groups.length ? r.groups.map((g) => h('div', { class: 'small' }, `👥 ${groupName(g)}`)) : h('span', { class: 'muted small' }, 'no group'),
      ),
      h('td', {}, r.lastRun ? [h('span', { class: `badge ${r.lastRun.status}` }, r.lastRun.status), h('div', { class: 'muted small' }, relTime(r.lastRun.started_at))] : h('span', { class: 'muted' }, '–')),
      h(
        'td',
        {},
        h('div', { class: 'row' },
          h('button', { class: 'small', onclick: (e) => busy(e.currentTarget, () => previewReport({ id: r.id }, r.title)) }, 'Preview'),
          h('button', {
            class: 'small',
            onclick: (e) =>
              busy(e.currentTarget, async () => {
                const res = await api('/reports/run', { method: 'POST', body: { id: r.id } });
                toast(res.note || `Queued for ${res.groups.length} group(s)`);
                await refreshStatus();
              }),
          }, 'Send now'),
        ),
      ),
    ),
  );
  return h(
    'div',
    { class: 'card' },
    h('h2', {}, 'Scheduled reports'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'stack-mobile' }, h('thead', {}, h('tr', {}, h('th', {}, 'Report'), h('th', {}, 'When'), h('th', {}, 'Sent to'), h('th', {}, 'Last run'), h('th', {}, ''))), h('tbody', {}, rows))),
  );
}

async function previewReport(body, title) {
  const res = await api('/reports/preview', { method: 'POST', body });
  const dialog = h(
    'dialog',
    { class: 'preview' },
    h('h2', { style: 'margin-top:0;font-size:16px' }, `Preview: ${title}`),
    res.empty ? h('p', { class: 'muted small' }, 'Nothing to report right now.') : null,
    h('div', { class: 'message-preview' }, res.text),
    res.attachmentName ? h('p', { class: 'small' }, `📎 ${res.attachmentName}`) : null,
    h('div', { class: 'row', style: 'margin-top:12px;justify-content:flex-end' }, h('button', { onclick: () => dialog.close() }, 'Close')),
  );
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------
async function renderSettings() {
  const root = $('#tab-settings');
  if (!state.draft) {
    root.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    try {
      state.settingsResponse = await api('/settings');
      state.draft = structuredClone(state.settingsResponse.settings);
      state.dirty = false;
      api('/erpnext/options').then((o) => {
        state.options = o;
        if (state.tab === 'settings') drawSettings();
      }).catch(() => undefined);
    } catch (error) {
      root.replaceChildren(h('p', { class: 'error-text' }, error.message));
      return;
    }
  }
  drawSettings();
}

function markDirty() {
  state.dirty = true;
  const bar = $('#save-state');
  if (bar) bar.textContent = 'Unsaved changes';
}

/** Two-way bound inputs on state.draft. */
function bindText(obj, key, attrs = {}) {
  return h('input', { type: 'text', value: obj[key] ?? '', ...attrs, oninput: (e) => { obj[key] = e.target.value; markDirty(); } });
}
function bindNumber(obj, key, attrs = {}) {
  return h('input', { type: 'number', value: obj[key], ...attrs, oninput: (e) => { obj[key] = e.target.value === '' ? 0 : Number(e.target.value); markDirty(); } });
}
function bindCheck(obj, key, label, hint) {
  return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: obj[key], onchange: (e) => { obj[key] = e.target.checked; markDirty(); } }), h('span', {}, label, hint ? h('span', { class: 'hint' }, hint) : null));
}
function bindSelect(obj, key, options, attrs = {}) {
  const values = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  if (obj[key] && !values.some((o) => o.value === obj[key])) values.push({ value: obj[key], label: obj[key] });
  return h('select', { onchange: (e) => { obj[key] = e.target.value; markDirty(); }, ...attrs }, values.map((o) => h('option', { value: o.value, selected: o.value === obj[key] }, o.label)));
}
function bindTextarea(obj, key, attrs = {}) {
  return h('textarea', { ...attrs, oninput: (e) => { obj[key] = e.target.value; markDirty(); } }, obj[key] ?? '');
}
function field(label, hint, input) {
  return h('label', {}, label, hint ? h('span', { class: 'hint' }, hint) : null, input);
}

/** Checkbox list of one WhatsApp number's groups, bound to an array of group IDs. */
function groupPicker(list, accountId, emptyHint) {
  const info = state.groupsByAccount[accountId];
  const groups = info?.groups ?? [];
  const ids = new Set([...groups.map((g) => g.id), ...list]);
  if (!ids.size) {
    return h('p', { class: 'muted small' }, info?.connected ? `"${accountLabel(accountId)}" is not in any group yet.` : `Link "${accountLabel(accountId)}" first to choose its groups.`);
  }
  const items = [...ids].map((id) => {
    const g = groups.find((x) => x.id === id);
    const label = g ? `${g.name} (${g.size})` : `Group not available on this number (${groupName(id)})`;
    const warn = g && g.announce && !g.isAdmin ? ' – only admins can post' : '';
    return h('label', { class: 'check' }, h('input', {
      type: 'checkbox',
      checked: list.includes(id),
      onchange: (e) => {
        const i = list.indexOf(id);
        if (e.target.checked && i < 0) list.push(id);
        if (!e.target.checked && i >= 0) list.splice(i, 1);
        markDirty();
      },
    }), h('span', {}, label, warn ? h('span', { class: 'hint' }, warn) : null));
  });
  return h('div', {}, h('div', { class: 'group-list' }, items), emptyHint ? h('span', { class: 'hint' }, emptyHint) : null);
}

/** "Companies & WhatsApp numbers": which number (and which groups) each ERPNext company uses. */
function companiesCard(companyNames) {
  const d = state.draft;
  return h('div', { class: 'card' },
    h('h2', {}, 'Companies & WhatsApp numbers'),
    h('p', { class: 'muted small' }, 'Each company sends its invoices and reports from its own WhatsApp number, to its own groups. "All other companies" covers every company without an entry of its own. Add numbers on the Overview page.'),
    d.companies.map((p, i) => profileEditor(p, i, companyNames)),
    h('div', { class: 'row', style: 'margin-top:14px' }, h('button', {
      onclick: () => {
        const used = new Set(d.companies.map((p) => p.company));
        const next = companyNames.find((c) => !used.has(c)) ?? '';
        if (used.has(next)) return toast('Every company already has an entry', 'error');
        d.companies.push({ company: next, accountId: d.whatsapp.accounts[0].id, salesGroups: [], purchaseGroups: [], reportGroups: [] });
        markDirty();
        drawSettings();
      },
    }, 'Add company')),
  );
}

function profileEditor(p, index, companyNames) {
  const d = state.draft;
  const companyOptions = [{ value: '', label: 'All other companies' }, ...companyNames];
  const accountOptions = d.whatsapp.accounts.map((a) => {
    const live = accounts().find((x) => x.id === a.id);
    const status = live?.state.status === 'connected' ? `+${live.state.me?.phone ?? ''}` : 'not linked';
    return { value: a.id, label: `${a.label || a.id} (${status})` };
  });
  return h('div', { class: 'report-item' },
    h('div', { class: 'report-head' },
      h('strong', {}, p.company || 'All other companies'),
      h('span', { class: 'spacer' }),
      d.companies.length > 1 ? h('button', { class: 'small danger', onclick: async () => { if (await askConfirm('Remove this company entry?', 'Remove')) { d.companies.splice(index, 1); markDirty(); drawSettings(); } } }, 'Remove') : null,
    ),
    h('div', { class: 'fields' },
      field('ERPNext company', null, bindSelect(p, 'company', companyOptions, { onchange: (e) => { p.company = e.target.value; markDirty(); drawSettings(); } })),
      field('Sends from WhatsApp number', null, bindSelect(p, 'accountId', accountOptions, {
        onchange: (e) => {
          p.accountId = e.target.value;
          // keep only groups the new number is in
          const keep = new Set(groupsOf(p.accountId).map((g) => g.id));
          for (const key of ['salesGroups', 'purchaseGroups', 'reportGroups']) p[key] = p[key].filter((id) => keep.has(id));
          markDirty();
          drawSettings();
        },
      })),
    ),
    h('label', {}, 'Copies of customer invoices go to'),
    groupPicker(p.salesGroups, p.accountId),
    h('label', {}, 'Copies of supplier invoices go to'),
    groupPicker(p.purchaseGroups, p.accountId),
    h('label', {}, 'Reports go to', h('span', { class: 'hint' }, 'Unless a report chooses its own groups.')),
    groupPicker(p.reportGroups, p.accountId),
  );
}

const INVOICE_VARIABLES =
  '{{name}} {{doc_title}} {{doc_label}} {{party_name}} {{company}} {{posting_date}} {{due_date}} {{grand_total}} {{outstanding_amount}} {{paid_amount}} {{currency}} {{bill_no}} {{bill_date}} {{po_no}} {{party_delivery}} {{doc.any_field}}';

function drawSettings() {
  const root = $('#tab-settings');
  const d = state.draft;
  const meta = state.settingsResponse;
  const opts = state.options || { companies: [], printFormats: { sales: [], purchase: [] }, letterheads: [], warehouses: [], accounts: [] };
  const locked = new Set(meta.locked);
  const companyNames = opts.companies.length ? opts.companies : state.status?.erpnext?.companies || [];
  const timezones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

  const erpCard = h(
    'div',
    { class: 'card' },
    h('h2', {}, 'ERPNext connection'),
    h('p', { class: 'muted small' }, 'In ERPNext: open the user this service should use → Settings → API Access → Generate Keys. Give that user the roles Accounts User, Sales User, Purchase User and Stock User.'),
    h('div', { class: 'fields' },
      field('ERPNext address', locked.has('erpnext.url') ? 'Set by ERPNEXT_URL' : 'e.g. https://erp.mycompany.com', bindText(d.erpnext, 'url', { placeholder: 'https://erp.example.com', disabled: locked.has('erpnext.url') })),
      field('API key', locked.has('erpnext.apiKey') ? 'Set by ERPNEXT_API_KEY' : null, bindText(d.erpnext, 'apiKey', { autocomplete: 'off', disabled: locked.has('erpnext.apiKey') })),
      field('API secret', locked.has('erpnext.apiSecret') ? 'Set by ERPNEXT_API_SECRET' : meta.apiSecretSet ? 'Saved – leave empty to keep it' : null, h('input', { type: 'password', autocomplete: 'new-password', placeholder: meta.apiSecretSet ? '•••••••• (saved)' : '', value: d.erpnext.apiSecret, disabled: locked.has('erpnext.apiSecret'), oninput: (e) => { d.erpnext.apiSecret = e.target.value; markDirty(); } })),
    ),
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('button', {
        onclick: (e) =>
          busy(e.currentTarget, async () => {
            const res = await api('/erpnext/test', { method: 'POST', body: { url: d.erpnext.url, apiKey: d.erpnext.apiKey, apiSecret: d.erpnext.apiSecret } });
            if (res.ok) toast(`Connected as ${res.user} (${Object.entries(res.versions || {}).map(([a, v]) => `${a} ${v}`).join(', ')})`);
            else toast(res.error, 'error');
          }),
      }, 'Test connection'),
    ),
  );

  const g = d.general;
  const generalCard = h(
    'div',
    { class: 'card' },
    h('h2', {}, 'General'),
    h('div', { class: 'fields' },
      field('Time zone', 'Empty = ERPNext time zone. Schedules use it.', h('div', {}, h('input', { type: 'text', list: 'tz-list', value: g.timezone, placeholder: 'e.g. Asia/Dubai', oninput: (e) => { g.timezone = e.target.value; markDirty(); } }), h('datalist', { id: 'tz-list' }, timezones.map((tz) => h('option', { value: tz }))))),
      field('Default country code', 'Used for local numbers such as 050…. Digits only, e.g. 971.', bindText(g, 'defaultCountryCode', { inputmode: 'numeric', placeholder: '971' })),
      field('Date format', null, bindSelect(g, 'dateFormat', meta.dateFormats)),
      field('Number format', null, bindSelect(g, 'numberLocale', [{ value: 'en-US', label: '1,234.56' }, { value: 'de-DE', label: '1.234,56' }, { value: 'fr-FR', label: '1 234,56' }, { value: 'en-IN', label: '1,23,456.78' }])),
      field('Pause between messages (seconds)', 'Keeps sending human-paced to protect the number.', bindNumber(g, 'sendDelaySeconds', { min: 1, max: 120 })),
    ),
    h('h3', {}, 'Test mode'),
    bindCheck(g, 'testMode', 'Test mode is ON', 'Invoice messages for customers and suppliers are sent to the test recipient below instead (group copies and reports are sent normally). Turn it off when you are happy with the messages.'),
    testRecipientField(g),
  );

  const invoiceCard = (key, title, partyWord) => {
    const c = d.invoices[key];
    return h(
      'div',
      { class: 'card' },
      h('h2', {}, title),
      bindCheck(c, 'enabled', `Send ${key === 'sales' ? 'Sales' : 'Purchase'} Invoices automatically when they are submitted`),
      bindCheck(c, 'sendToParty', `Send to the ${partyWord}'s WhatsApp`, `Uses the ${partyWord}'s mobile number in ERPNext (invoice contact, ${partyWord} or linked contact).`),
      bindCheck(c, 'attachPdf', 'Attach the invoice PDF'),
      bindCheck(c, 'includeReturns', key === 'sales' ? 'Also send credit notes' : 'Also send debit notes'),
      h('p', { class: 'hint' }, 'Which groups get a copy is set per company under "Companies & WhatsApp numbers".'),
      h('div', { class: 'fields' },
        field('Print format', null, bindSelect(c, 'printFormat', [{ value: '', label: 'Default print format' }, ...(opts.printFormats[key] || [])])),
        field('Letter head', null, bindSelect(c, 'letterhead', [{ value: '', label: 'Default letter head' }, ...opts.letterheads])),
      ),
      field(`Message to the ${partyWord}`, 'Sent as the PDF caption. *bold*, _italic_ work like in WhatsApp.', bindTextarea(c, 'partyMessage')),
      field('Message to the groups', null, bindTextarea(c, 'groupMessage', { style: 'min-height:110px' })),
      h('p', { class: 'hint' }, 'Variables: ', h('code', {}, INVOICE_VARIABLES), '. Optional lines: ', h('code', {}, '{{#due_date}}Due: {{due_date}}{{/due_date}}')),
    );
  };

  const inv = d.invoices;
  const advancedCard = h(
    'div',
    { class: 'card' },
    h('h2', {}, 'Invoice options'),
    h('div', { class: 'fields' },
      field('Check ERPNext every (seconds)', null, bindNumber(inv, 'pollIntervalSeconds', { min: 15, max: 3600 })),
      field('Ignore invoices older than (days)', 'Automatic sending skips invoices with an older posting date.', bindNumber(inv, 'maxAgeDays', { min: 0, max: 365 })),
      field('WhatsApp number field (optional)', 'Custom field on Customer/Supplier, e.g. custom_whatsapp. Used first when filled.', bindText(inv, 'whatsappField', { placeholder: 'custom_whatsapp' })),
      field('PDF generator (ERPNext v16+)', 'Choose wkhtmltopdf if PDFs fail with "Connection error".', bindSelect(inv, 'pdfGenerator', [{ value: '', label: 'ERPNext setting' }, { value: 'chrome', label: 'Chrome' }, { value: 'wkhtmltopdf', label: 'wkhtmltopdf' }])),
    ),
    h('details', {}, h('summary', {}, 'Instant sending with an ERPNext webhook (optional)'),
      h('p', { class: 'small' }, 'Without a webhook, new invoices are picked up within the check interval above. For instant sending, add a Webhook in ERPNext (search "Webhook" → New):'),
      h('ul', { class: 'small' },
        h('li', {}, 'DocType: Sales Invoice (and a second one for Purchase Invoice), Doc Event: on_submit'),
        h('li', {}, ['Request URL: ', h('code', {}, `${location.origin}${meta.webhook.path}`)]),
        h('li', {}, 'Request Method: POST, Request Structure: JSON'),
        h('li', {}, ['JSON Request Body: ', h('code', {}, '{"doctype": "{{ doc.doctype }}", "name": "{{ doc.name }}"}')]),
        h('li', {}, meta.webhook.secretSet ? 'Enable Security and use the same secret as WEBHOOK_SECRET.' : 'Set WEBHOOK_SECRET in .env and enable Security in the webhook with the same secret.'),
      ),
    ),
  );

  root.replaceChildren(
    h('div', { class: 'stack' },
      erpCard,
      generalCard,
      companiesCard(companyNames),
      invoiceCard('sales', 'Customer invoices (Sales Invoice)', 'customer'),
      invoiceCard('purchase', 'Supplier invoices (Purchase Invoice)', 'supplier'),
      advancedCard,
      reportsSettingsCard(opts),
      h('div', { class: 'save-bar' },
        h('span', { id: 'save-state', class: 'muted small' }, state.dirty ? 'Unsaved changes' : ''),
        h('button', { onclick: () => { state.draft = null; state.dirty = false; renderSettings(); } }, 'Discard changes'),
        h('button', { class: 'primary', onclick: (e) => busy(e.currentTarget, saveSettings) }, 'Save settings'),
      ),
    ),
  );
}

/** Test recipient: one of the groups, or a phone number. */
function testRecipientField(g) {
  const isGroup = g.testRecipient.endsWith('@g.us');
  const phone = h('input', {
    type: 'text',
    placeholder: '+971501234567',
    inputmode: 'tel',
    value: isGroup ? '' : g.testRecipient,
    class: isGroup ? 'hidden' : '',
    oninput: (e) => { g.testRecipient = e.target.value; markDirty(); },
  });
  const groups = allGroups();
  const many = accounts().length > 1;
  const known = groups.some((x) => x.id === g.testRecipient);
  const select = h(
    'select',
    {
      onchange: (e) => {
        g.testRecipient = e.target.value === 'phone' ? phone.value : e.target.value;
        phone.classList.toggle('hidden', e.target.value !== 'phone');
        markDirty();
      },
    },
    h('option', { value: 'phone', selected: !isGroup }, 'A phone number'),
    groups.map((x) => h('option', { value: x.id, selected: x.id === g.testRecipient }, `👥 ${x.name}${many ? ` (${accountLabel(x.accountId)})` : ''}`)),
    isGroup && !known ? h('option', { value: g.testRecipient, selected: true }, `Group ${g.testRecipient}`) : null,
  );
  return field('Test recipient', `Where test-mode messages go. Leave the number empty to only log them in Activity.${many ? ' A group only works for companies whose number is in that group.' : ''}`, h('div', { class: 'fields' }, select, phone));
}

async function saveSettings() {
  const res = await api('/settings', { method: 'PUT', body: state.draft });
  state.settingsResponse = { ...state.settingsResponse, settings: res.settings, apiSecretSet: res.apiSecretSet };
  state.draft = structuredClone(res.settings);
  state.dirty = false;
  toast('Settings saved');
  drawSettings();
  setTimeout(() => refreshStatus(), 1500);
}

const REPORT_DEFAULTS = {
  daily_sales: { schedule: '0 20 * * *', options: { day: 'today', topCustomers: 5, includePayments: true, includeMonthToDate: true } },
  receivables: { schedule: '0 9 * * *', options: { topParties: 10, onlyOverdue: false } },
  payables: { schedule: '5 9 * * *', options: { topParties: 10, onlyOverdue: false } },
  stock_alerts: { schedule: '0 8 * * *', options: { basedOn: 'actual_qty', maxItems: 30, sendWhenEmpty: false, warehouses: [] } },
  cash_bank: { schedule: '5 20 * * *', options: { accounts: [], hideZero: false } },
  query_report: { schedule: '0 18 * * 5', options: { reportName: '', filters: { company: '{{company}}' }, columns: [], maxRows: 20, output: 'text', sendWhenEmpty: true } },
};

function reportsSettingsCard(opts) {
  const reports = state.draft.reports;
  const types = state.settingsResponse.reportTypes;
  const typeSelect = h('select', {}, Object.entries(types).map(([value, label]) => h('option', { value }, label)));
  return h(
    'div',
    { class: 'card' },
    h('h2', {}, 'Reports to WhatsApp groups'),
    h('p', { class: 'muted small' }, 'Each report is sent from the WhatsApp number of its company, to that company\'s report groups unless you choose groups here.'),
    reports.items.map((r, i) => reportEditor(r, i, opts)),
    h('div', { class: 'row', style: 'margin-top:14px' }, typeSelect, h('button', {
      onclick: () => {
        const type = typeSelect.value;
        const base = structuredClone(REPORT_DEFAULTS[type]);
        reports.items.push({ id: `${type.replace(/_/g, '-')}-${Date.now().toString(36)}`, type, title: '', enabled: true, groups: [], ...base });
        markDirty();
        drawSettings();
      },
    }, 'Add report')),
  );
}

function scheduleEditor(report) {
  const s = parseCron(report.schedule);
  const update = () => {
    report.schedule = buildCron(s);
    desc.textContent = describeCron(report.schedule);
    markDirty();
  };
  const desc = h('span', { class: 'hint' }, describeCron(report.schedule));
  const freq = h('select', {
    onchange: (e) => {
      s.freq = e.target.value;
      if (s.freq === 'custom') s.cron = report.schedule;
      s.time = s.time || '20:00';
      update();
      redraw();
    },
  }, [['daily', 'Every day'], ['weekdays', 'Monday–Friday'], ['mon-sat', 'Monday–Saturday'], ['weekly', 'Once a week'], ['monthly', 'Once a month'], ['custom', 'Custom (cron)']].map(([v, l]) => h('option', { value: v, selected: s.freq === v }, l)));
  const wrap = h('div', { class: 'row' });
  const redraw = () => {
    const parts = [freq];
    if (s.freq === 'custom') {
      parts.push(h('input', { type: 'text', value: s.cron, style: 'max-width:200px', placeholder: 'm h dom mon dow', oninput: (e) => { s.cron = e.target.value; update(); } }));
    } else {
      if (s.freq === 'weekly') parts.push(h('select', { onchange: (e) => { s.dow = Number(e.target.value); update(); } }, WEEKDAYS.map((name, i) => h('option', { value: i, selected: (s.dow ?? 1) === i }, name))));
      if (s.freq === 'monthly') parts.push(h('input', { type: 'number', min: 1, max: 28, value: s.dom ?? 1, style: 'max-width:90px', oninput: (e) => { s.dom = Number(e.target.value) || 1; update(); } }));
      parts.push(h('input', { type: 'time', value: s.time, style: 'max-width:140px', oninput: (e) => { s.time = e.target.value; update(); } }));
    }
    wrap.replaceChildren(...parts.map((p) => h('div', { style: 'flex: 0 1 auto' }, p)));
  };
  redraw();
  return h('div', {}, wrap, desc);
}

function reportEditor(r, index, opts) {
  const types = state.settingsResponse.reportTypes;
  const o = r.options;
  const optionFields = [];
  switch (r.type) {
    case 'daily_sales':
      optionFields.push(
        field('Which day', null, bindSelect(o, 'day', [{ value: 'today', label: 'Today (send in the evening)' }, { value: 'yesterday', label: 'Yesterday (send in the morning)' }])),
        field('Top customers to list', null, bindNumber(o, 'topCustomers', { min: 0, max: 50 })),
        bindCheck(o, 'includePayments', 'Show payments received'),
        bindCheck(o, 'includeMonthToDate', 'Show month-to-date sales'),
      );
      break;
    case 'receivables':
    case 'payables':
      optionFields.push(field(r.type === 'receivables' ? 'Customers to list' : 'Suppliers to list', null, bindNumber(o, 'topParties', { min: 1, max: 50 })), bindCheck(o, 'onlyOverdue', 'Only list overdue ones'));
      break;
    case 'stock_alerts':
      optionFields.push(
        field('Compare with', null, bindSelect(o, 'basedOn', [{ value: 'actual_qty', label: 'Stock on hand' }, { value: 'projected_qty', label: 'Projected stock (incl. orders)' }])),
        field('Max items in the message', null, bindNumber(o, 'maxItems', { min: 1, max: 200 })),
        bindCheck(o, 'sendWhenEmpty', 'Send a message even when nothing is low'),
        field('Only these warehouses (comma separated, empty = all)', opts.warehouses.length ? `Warehouses: ${opts.warehouses.join(', ')}` : null, h('input', { type: 'text', value: o.warehouses.join(', '), oninput: (e) => { o.warehouses = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); markDirty(); } })),
      );
      break;
    case 'cash_bank':
      optionFields.push(
        bindCheck(o, 'hideZero', 'Hide accounts with zero balance'),
        field('Only these accounts (comma separated, empty = all Bank & Cash accounts)', opts.accounts.length ? `Accounts: ${opts.accounts.join(', ')}` : null, h('input', { type: 'text', value: o.accounts.join(', '), oninput: (e) => { o.accounts = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); markDirty(); } })),
      );
      break;
    case 'query_report': {
      const filtersInput = h('textarea', { style: 'min-height:90px' }, JSON.stringify(o.filters, null, 2));
      const filtersError = h('span', { class: 'error-text small' });
      filtersInput.addEventListener('input', () => {
        try {
          o.filters = JSON.parse(filtersInput.value || '{}');
          filtersError.textContent = '';
          markDirty();
        } catch {
          filtersError.textContent = 'Not valid JSON yet';
        }
      });
      optionFields.push(
        field('ERPNext report name', 'Exactly as in ERPNext, e.g. "Accounts Receivable Summary", "Gross Profit", "Sales Analytics".', bindText(o, 'reportName')),
        field('Filters (JSON)', 'Placeholders: {{today}} {{yesterday}} {{week_start}} {{month_start}} {{year_start}} {{company}}', filtersInput),
        filtersError,
        field('Send as', null, bindSelect(o, 'output', [{ value: 'text', label: 'Text in the message' }, { value: 'csv', label: 'CSV file (all rows)' }])),
        field('Columns (comma separated fieldnames, empty = automatic)', null, h('input', { type: 'text', value: o.columns.join(', '), oninput: (e) => { o.columns = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); markDirty(); } })),
        field('Max rows in the message', null, bindNumber(o, 'maxRows', { min: 1, max: 200 })),
        bindCheck(o, 'sendWhenEmpty', 'Send even when the report has no rows'),
      );
      break;
    }
  }

  return h(
    'div',
    { class: `report-item ${r.enabled ? '' : 'disabled'}` },
    h('div', { class: 'report-head' },
      h('label', { class: 'check', style: 'margin:0' }, h('input', { type: 'checkbox', checked: r.enabled, onchange: (e) => { r.enabled = e.target.checked; markDirty(); drawSettings(); } }), h('strong', {}, r.title || types[r.type])),
      h('span', { class: 'badge' }, types[r.type]),
      h('span', { class: 'spacer' }),
      h('button', { class: 'small', onclick: (e) => busy(e.currentTarget, () => previewReport({ report: r }, r.title || types[r.type])) }, 'Preview'),
      h('button', { class: 'small danger', onclick: async () => { if (await askConfirm('Remove this report?', 'Remove')) { state.draft.reports.items.splice(index, 1); markDirty(); drawSettings(); } } }, 'Remove'),
    ),
    h('div', { class: 'fields' },
      field('Title (optional)', null, bindText(r, 'title', { placeholder: types[r.type] })),
      field('Company', null, bindSelect(r, 'company', [{ value: '', label: `ERPNext default${defaultCompany() ? ` (${defaultCompany()})` : ''}` }, ...(opts.companies.length ? opts.companies : state.status?.erpnext?.companies || [])], { onchange: (e) => { r.company = e.target.value; markDirty(); drawSettings(); } })),
      h('label', {}, 'When', scheduleEditor(r)),
    ),
    (() => {
      const profile = profileFor(state.draft.companies, r.company || defaultCompany());
      if (!profile) return h('p', { class: 'error-text small' }, 'This company has no WhatsApp number (Companies & WhatsApp numbers above).');
      return h('div', {},
        h('label', {}, `Send to groups (from "${accountLabel(profile.accountId)}")`, h('span', { class: 'hint' }, 'None ticked = the company\'s report groups.')),
        groupPicker(r.groups, profile.accountId),
      );
    })(),
    optionFields.length ? h('details', {}, h('summary', {}, 'Options'), h('div', { class: 'fields' }, optionFields)) : null,
  );
}

// ---------------------------------------------------------------------------
// activity
// ---------------------------------------------------------------------------
async function renderActivity(append = false) {
  const root = $('#tab-activity');
  const a = state.activity;
  if (!append) a.offset = 0;
  try {
    const params = new URLSearchParams({ status: a.status, kind: a.kind, search: a.search, limit: '50', offset: String(a.offset) });
    const data = await api(`/messages?${params}`);
    a.rows = append ? [...a.rows, ...data.rows] : data.rows;
    a.total = data.total;
  } catch (error) {
    root.replaceChildren(h('p', { class: 'error-text' }, error.message));
    return;
  }

  const filters = h(
    'div',
    { class: 'row' },
    h('select', { onchange: (e) => { a.status = e.target.value; renderActivity(); } }, [['', 'All statuses'], ['sent', 'Sent'], ['queued', 'Waiting'], ['failed', 'Failed'], ['skipped', 'Skipped']].map(([v, l]) => h('option', { value: v, selected: a.status === v }, l))),
    h('select', { onchange: (e) => { a.kind = e.target.value; renderActivity(); } }, [['', 'All types'], ['invoice', 'Invoices'], ['report', 'Reports'], ['test', 'Test messages']].map(([v, l]) => h('option', { value: v, selected: a.kind === v }, l))),
    h('input', { type: 'text', placeholder: 'Search invoice, name, number…', value: a.search, style: 'max-width:280px', onchange: (e) => { a.search = e.target.value; renderActivity(); } }),
    h('span', { class: 'spacer' }),
    h('button', { onclick: (e) => busy(e.currentTarget, () => renderActivity()) }, 'Refresh'),
  );

  const statusLabel = { sent: 'sent', queued: 'waiting', sending: 'sending', failed: 'failed', skipped: 'skipped' };
  const rows = a.rows.map((m) => {
    const text = h('div', { class: 'preview-text' }, m.body);
    const to = m.recipient === '-' ? m.recipient_name || '–' : m.recipient.endsWith('@g.us') ? `👥 ${groupName(m.recipient)}` : `${m.recipient_name ? `${m.recipient_name} · ` : ''}+${m.recipient.replace(/@.*/, '')}`;
    return h(
      'tr',
      {},
      h('td', {}, h('div', { class: 'small' }, fmtTime(m.created_at)), h('div', { class: 'muted small' }, m.kind)),
      h('td', {}, h('div', { class: 'small' }, m.ref_name || '–'), m.audience === 'test' ? h('span', { class: 'badge' }, 'test mode') : null),
      h('td', { class: 'small' }, to, accounts().length > 1 ? h('div', { class: 'muted small' }, `from ${accountLabel(m.account_id)}`) : null),
      h('td', { class: 'preview' }, h('div', { onclick: () => text.classList.toggle('open'), title: 'Click to expand' }, text), m.attachment_name ? h('div', { class: 'small muted' }, `📎 ${m.attachment_name}`) : null),
      h('td', {}, h('span', { class: `badge ${m.status}` }, statusLabel[m.status] || m.status), m.error ? h('div', { class: 'small error-text' }, m.error) : null, m.sent_at ? h('div', { class: 'muted small' }, relTime(m.sent_at)) : null),
      h('td', {}, ['failed', 'skipped'].includes(m.status)
        ? h('button', {
            class: 'small',
            onclick: (e) => busy(e.currentTarget, async () => { await api(`/messages/${m.id}/retry`, { method: 'POST' }); toast('Queued again'); await renderActivity(); }),
          }, 'Retry')
        : null),
    );
  });

  root.replaceChildren(
    h('div', { class: 'card' },
      h('h2', {}, 'Messages'),
      filters,
      h('div', { class: 'table-wrap', style: 'margin-top:12px' },
        h('table', { class: 'stack-mobile' }, h('thead', {}, h('tr', {}, ['When', 'Document', 'To', 'Message', 'Status', ''].map((t) => h('th', {}, t)))), h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: 6, class: 'muted' }, 'No messages yet.')))),
      ),
      a.rows.length < a.total ? h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { onclick: () => { a.offset += 50; renderActivity(true); } }, `Load more (${a.total - a.rows.length})`)) : null,
    ),
  );
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------
/** Pick the sending number, then a group of that number or a phone number. */
function recipientPicker() {
  const list = accounts();
  const from = h('select', {}, list.map((a) => h('option', { value: a.id }, `${a.label}${a.state.status === 'connected' ? '' : ' (not linked)'}`)));
  const to = h('select', {});
  const phone = h('input', { type: 'text', placeholder: '+971501234567', inputmode: 'tel' });
  const fill = () => {
    to.replaceChildren(h('option', { value: '' }, 'Phone number…'), ...groupsOf(from.value).map((g) => h('option', { value: g.id }, `👥 ${g.name}`)));
    phone.classList.remove('hidden');
  };
  from.addEventListener('change', fill);
  to.addEventListener('change', () => phone.classList.toggle('hidden', Boolean(to.value)));
  fill();
  return {
    el: h('div', { class: 'fields' }, list.length > 1 ? field('From number', null, from) : null, field('Send to', null, to), field('Phone number', null, phone)),
    accountId: () => from.value,
    value: () => to.value || phone.value,
  };
}

function renderTools() {
  const root = $('#tab-tools');
  const testTo = recipientPicker();
  const testText = h('textarea', { style: 'min-height:80px' }, '✅ Test message from Auto SMS for ERPNext');

  const docType = h('select', {}, h('option', { value: 'Sales Invoice' }, 'Sales Invoice (customer)'), h('option', { value: 'Purchase Invoice' }, 'Purchase Invoice (supplier)'));
  const docName = h('input', { type: 'text', placeholder: 'e.g. ACC-SINV-2026-00012' });
  const toParty = h('input', { type: 'checkbox', checked: true });
  const toGroups = h('input', { type: 'checkbox', checked: true });

  root.replaceChildren(
    h('div', { class: 'grid' },
      h('div', { class: 'card' },
        h('h2', {}, 'Send a test message'),
        h('p', { class: 'muted small' }, 'Check that WhatsApp works. Test mode does not apply here.'),
        testTo.el,
        field('Message', null, testText),
        h('div', { class: 'row', style: 'margin-top:12px' }, h('button', {
          class: 'primary',
          onclick: (e) => busy(e.currentTarget, async () => { await api('/test-message', { method: 'POST', body: { accountId: testTo.accountId(), to: testTo.value(), text: testText.value } }); toast('Queued – see Activity'); }),
        }, 'Send')),
      ),
      h('div', { class: 'card' },
        h('h2', {}, 'Send an invoice now'),
        h('p', { class: 'muted small' }, 'Sends (or re-sends) a submitted invoice, even an old one. Test mode still applies to customer/supplier messages.'),
        h('div', { class: 'fields' }, field('Type', null, docType), field('Invoice number', null, docName)),
        h('label', { class: 'check' }, toParty, h('span', {}, 'To the customer / supplier')),
        h('label', { class: 'check' }, toGroups, h('span', {}, 'To the configured groups')),
        h('div', { class: 'row', style: 'margin-top:12px' }, h('button', {
          class: 'primary',
          onclick: (e) => busy(e.currentTarget, async () => {
            const only = [toParty.checked ? 'party' : null, toGroups.checked ? 'group' : null].filter(Boolean);
            if (!only.length) throw new Error('Tick at least one option');
            const res = await api('/invoices/send', { method: 'POST', body: { doctype: docType.value, name: docName.value, only } });
            toast(res.status === 'queued' ? `Queued: ${res.detail}` : `Not sent: ${res.detail}`, res.status === 'queued' ? 'info' : 'error');
          }),
        }, 'Send invoice')),
      ),
      h('div', { class: 'card' },
        h('h2', {}, 'Check ERPNext now'),
        h('p', { class: 'muted small' }, 'Looks for newly submitted invoices right away instead of waiting for the next check.'),
        h('button', {
          onclick: (e) => busy(e.currentTarget, async () => { const r = await api('/watcher/poll', { method: 'POST' }); toast(`Checked ${r.checked} invoice(s), queued ${r.processed}`); }),
        }, 'Check for new invoices'),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------
async function renderLogs() {
  const root = $('#tab-logs');
  try {
    const { logs } = await api('/logs');
    root.replaceChildren(
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, 'Recent log'), h('span', { class: 'spacer' }), h('button', { class: 'small', onclick: () => renderLogs() }, 'Refresh')),
        h('div', { class: 'logs', style: 'margin-top:12px' }, logs.length ? logs.map((l) => h('div', { class: l.level }, `${fmtTime(l.time)}  ${l.level.toUpperCase().padEnd(5)}  ${l.scope ? `[${l.scope}] ` : ''}${l.message}`)) : h('span', { class: 'muted' }, 'Nothing logged yet.')),
      ),
    );
  } catch (error) {
    root.replaceChildren(h('p', { class: 'error-text' }, error.message));
  }
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------
(async () => {
  await (window.AUTO_SMS_READY || Promise.resolve());
  if (DEMO) {
    $('#demo-banner').classList.remove('hidden');
    $('#logout').textContent = 'Exit demo';
  }
  if (STATIC && !DEMO && !apiBase) {
    showLogin();
    return;
  }
  try {
    const { loggedIn } = await api('/session');
    if (loggedIn) await showShell();
    else showLogin();
  } catch {
    showLogin();
  }
})();

// Installable like an app ("Add to Home Screen"), and opens without a connection.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => undefined);
}
