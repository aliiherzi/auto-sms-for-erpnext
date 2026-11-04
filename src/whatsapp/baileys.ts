/**
 * WhatsApp connection through Baileys (links like WhatsApp Web – QR code or pairing code).
 *
 * The session is stored in DATA_DIR/whatsapp-auth so the link survives restarts.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import QRCode from 'qrcode';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidDecode,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type GroupMetadata,
  type WASocket,
  type proto,
} from 'baileys';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { Logger } from '../util/logger.js';
import { createLogger } from '../util/logger.js';
import {
  PermanentSendError,
  type DocumentPayload,
  type SendResult,
  type WhatsAppClient,
  type WhatsAppGroup,
  type WhatsAppState,
  type WhatsAppStatus,
} from './types.js';

export interface BaileysOptions {
  authDir: string;
  logger: Logger;
  proxyUrl?: string;
  /** Log level for Baileys' own (very chatty) internals. */
  libraryLogLevel?: string;
}

type WAVersion = [number, number, number];

const GROUP_CACHE_MS = 60_000;
const NUMBER_CACHE_MS = 24 * 3_600_000;
const SENT_CACHE_SIZE = 500;

function statusCodeOf(error: unknown): number | undefined {
  const err = error as { output?: { statusCode?: number }; statusCode?: number } | undefined;
  return err?.output?.statusCode ?? err?.statusCode;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms).unref())]);
}

export class BaileysWhatsApp extends EventEmitter implements WhatsAppClient {
  readonly driver = 'baileys' as const;
  private sock?: WASocket;
  private generation = 0;
  private state: WhatsAppState = { status: 'stopped', driver: 'baileys', updatedAt: new Date().toISOString() };
  private stopped = true;
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private version?: WAVersion;
  private groupCache = new Map<string, GroupMetadata>();
  private groupsFetchedAt = 0;
  private numberCache = new Map<string, { jid: string | null; at: number }>();
  private sentMessages = new Map<string, proto.IMessage>();
  private qrWaiters: Array<() => void> = [];
  private readonly log: Logger;
  private readonly libraryLogger: Logger;

  constructor(private readonly options: BaileysOptions) {
    super();
    this.log = options.logger.child({ scope: 'whatsapp' });
    this.libraryLogger = createLogger(options.libraryLogLevel ?? 'error', 'baileys');
  }

  getState(): WhatsAppState {
    return { ...this.state };
  }

  isConnected(): boolean {
    return this.state.status === 'connected' && Boolean(this.sock);
  }

  private setState(status: WhatsAppStatus, patch: Partial<WhatsAppState> = {}): void {
    const keepQr = status === 'waiting_for_scan';
    this.state = {
      status,
      driver: 'baileys',
      me: patch.me ?? (status === 'connected' ? this.state.me : undefined),
      qrDataUrl: patch.qrDataUrl ?? (keepQr ? this.state.qrDataUrl : undefined),
      pairingCode: patch.pairingCode ?? (keepQr ? this.state.pairingCode : undefined),
      lastError: patch.lastError,
      updatedAt: new Date().toISOString(),
    };
    this.emit('state', this.getState());
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.closeSocket();
    this.setState('stopped');
  }

  private closeSocket(): void {
    const sock = this.sock;
    this.sock = undefined;
    this.generation++; // ignore events from the old socket
    if (sock) {
      try {
        sock.ev.removeAllListeners('connection.update');
        sock.end(undefined);
      } catch {
        // already closed
      }
    }
  }

  private async hasSession(): Promise<boolean> {
    try {
      const raw = await fs.readFile(`${this.options.authDir}/creds.json`, 'utf8');
      return Boolean(JSON.parse(raw)?.registered || JSON.parse(raw)?.me);
    } catch {
      return false;
    }
  }

  private async wipeSession(): Promise<void> {
    await fs.rm(this.options.authDir, { recursive: true, force: true });
    this.groupCache.clear();
    this.groupsFetchedAt = 0;
    this.numberCache.clear();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    this.closeSocket();
    const generation = this.generation;

    await fs.mkdir(this.options.authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.options.authDir);

    if (!this.version) {
      const latest = await withTimeout(fetchLatestBaileysVersion().catch(() => undefined), 5000);
      if (latest?.version) this.version = latest.version as WAVersion;
    }

    const agent = this.options.proxyUrl ? new HttpsProxyAgent(this.options.proxyUrl) : undefined;
    this.setState(this.state.status === 'connected' ? 'reconnecting' : 'connecting');

    const sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, this.libraryLogger) },
      logger: this.libraryLogger,
      browser: Browsers.ubuntu('Chrome'),
      ...(this.version ? { version: this.version } : {}),
      ...(agent ? { agent, fetchAgent: agent } : {}),
      markOnlineOnConnect: false, // keep notifications on the phone
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
      getMessage: async (key) => (key.id ? this.sentMessages.get(key.id) : undefined),
      cachedGroupMetadata: async (jid) => this.groupCache.get(jid),
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('groups.update', (updates) => {
      for (const update of updates) {
        const cached = update.id ? this.groupCache.get(update.id) : undefined;
        if (cached) this.groupCache.set(update.id!, { ...cached, ...update } as GroupMetadata);
      }
    });
    sock.ev.on('group-participants.update', ({ id }) => {
      this.groupCache.delete(id);
      this.groupsFetchedAt = 0;
    });

    sock.ev.on('connection.update', async (update) => {
      if (generation !== this.generation) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
        this.setState('waiting_for_scan', { qrDataUrl });
        const waiters = this.qrWaiters.splice(0);
        waiters.forEach((resolve) => resolve());
      }

      if (connection === 'open') {
        this.reconnectAttempts = 0;
        const user = sock.user;
        const phone = jidDecode(user?.id)?.user ?? '';
        this.setState('connected', { me: { id: jidNormalizedUser(user?.id), phone, name: user?.name || user?.notify } });
        this.log.info(`Connected to WhatsApp as +${phone}`);
        this.emit('connected');
        this.listGroups(true).catch((error) => this.log.warn({ err: error }, 'Could not load WhatsApp groups'));
      }

      if (connection === 'close') {
        const error = lastDisconnect?.error as Error | undefined;
        const code = statusCodeOf(error);
        const message = error?.message ?? 'connection closed';
        this.sock = undefined;
        this.emit('disconnected');
        await this.handleClose(code, message);
      }
    });
  }

  private async handleClose(code: number | undefined, message: string): Promise<void> {
    if (this.stopped) return;

    if (code === DisconnectReason.loggedOut) {
      this.log.warn('WhatsApp session was logged out (removed from Linked devices). Link again from the dashboard.');
      await this.wipeSession();
      this.setState('not_linked', { lastError: 'Logged out from the phone. Scan a new QR code to link again.' });
      return;
    }
    if (code === DisconnectReason.restartRequired) {
      // Normal right after scanning the QR code.
      await this.connect();
      return;
    }
    if (/QR refs attempts ended/i.test(message) || (code === DisconnectReason.timedOut && this.state.status === 'waiting_for_scan')) {
      this.setState('not_linked', { lastError: 'The QR code expired before it was scanned.' });
      return;
    }
    if (code === DisconnectReason.connectionReplaced) {
      this.log.error('Another program opened this WhatsApp session. Only run one copy of this service per number.');
      this.setState('error', { lastError: 'Session opened somewhere else (connection replaced). Press "Reconnect" once the other copy is stopped.' });
      return;
    }
    if (code === DisconnectReason.forbidden) {
      this.setState('error', { lastError: 'WhatsApp refused the connection (403). The number may be restricted.' });
      return;
    }
    if (code === DisconnectReason.multideviceMismatch || code === DisconnectReason.badSession) {
      if (!(await this.hasSession())) {
        await this.wipeSession();
        this.setState('not_linked', { lastError: `Session problem (${code}). Link again.` });
        return;
      }
    }

    const hadSession = await this.hasSession();
    if (!hadSession && this.state.status !== 'connected' && this.reconnectAttempts >= 3) {
      this.setState('not_linked', { lastError: message });
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(120_000, 2_000 * 2 ** Math.min(this.reconnectAttempts - 1, 6));
    this.log.warn(`WhatsApp disconnected (${code ?? 'no code'}: ${message}); reconnecting in ${Math.round(delay / 1000)}s`);
    this.setState('reconnecting', { lastError: message });
    this.reconnectTimer = setTimeout(() => this.connect().catch((err) => this.log.error({ err }, 'Reconnect failed')), delay);
    this.reconnectTimer.unref();
  }

  async startLinking(): Promise<void> {
    if (this.isConnected()) return;
    this.stopped = false;
    this.reconnectAttempts = 0;
    if (!(await this.hasSession())) await this.wipeSession();
    await this.connect();
  }

  private waitForQr(timeoutMs = 30_000): Promise<void> {
    if (this.state.status === 'waiting_for_scan') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WhatsApp did not respond in time. Try again.')), timeoutMs);
      this.qrWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async requestPairingCode(phone: string): Promise<string> {
    if (this.isConnected()) throw new Error('WhatsApp is already linked.');
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 8) throw new Error('Enter the full number with country code, e.g. 971501234567');
    if (this.state.status !== 'waiting_for_scan' || !this.sock) {
      await this.startLinking();
    }
    await this.waitForQr();
    if (!this.sock) throw new Error('WhatsApp connection closed. Try again.');
    const raw = await this.sock.requestPairingCode(digits);
    const code = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
    this.setState('waiting_for_scan', { pairingCode: code });
    return code;
  }

  async logout(): Promise<void> {
    const sock = this.sock;
    clearTimeout(this.reconnectTimer);
    if (sock && this.isConnected()) {
      try {
        await sock.logout();
      } catch (error) {
        this.log.warn({ err: error }, 'Logout request failed; removing the local session anyway');
      }
    }
    this.closeSocket();
    await this.wipeSession();
    this.setState('not_linked');
  }

  private requireSocket(): WASocket {
    if (!this.sock || !this.isConnected()) throw new Error('WhatsApp is not connected');
    return this.sock;
  }

  async listGroups(force = false): Promise<WhatsAppGroup[]> {
    const sock = this.requireSocket();
    if (force || Date.now() - this.groupsFetchedAt > GROUP_CACHE_MS || this.groupCache.size === 0) {
      const all = await sock.groupFetchAllParticipating();
      this.groupCache = new Map(Object.entries(all));
      this.groupsFetchedAt = Date.now();
    }
    const meIds = new Set([jidNormalizedUser(sock.user?.id), sock.user?.lid ? jidNormalizedUser(sock.user.lid) : ''].filter(Boolean));
    return [...this.groupCache.values()]
      .map((g) => {
        const me = g.participants.find((p) => meIds.has(jidNormalizedUser(p.id)) || (p.phoneNumber && meIds.has(jidNormalizedUser(p.phoneNumber))) || (p.lid && meIds.has(jidNormalizedUser(p.lid))));
        return {
          id: g.id,
          name: g.subject || g.id,
          size: g.size ?? g.participants.length,
          announce: Boolean(g.announce),
          isAdmin: Boolean(me?.admin || me?.isAdmin || me?.isSuperAdmin),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async lookupNumber(digits: string): Promise<string | null> {
    const cached = this.numberCache.get(digits);
    if (cached && Date.now() - cached.at < NUMBER_CACHE_MS) return cached.jid;
    const sock = this.requireSocket();
    const results = await sock.onWhatsApp(digits);
    const match = results?.find((r) => r.exists);
    const jid = match ? jidNormalizedUser(match.jid) : null;
    this.numberCache.set(digits, { jid, at: Date.now() });
    return jid;
  }

  private remember(message: proto.IWebMessageInfo | undefined): void {
    const id = message?.key?.id;
    if (!id || !message?.message) return;
    this.sentMessages.set(id, message.message);
    if (this.sentMessages.size > SENT_CACHE_SIZE) {
      const oldest = this.sentMessages.keys().next().value;
      if (oldest) this.sentMessages.delete(oldest);
    }
  }

  private async send(jid: string, content: Parameters<WASocket['sendMessage']>[1]): Promise<SendResult> {
    const sock = this.requireSocket();
    try {
      const sent = await sock.sendMessage(jid, content);
      this.remember(sent);
      return { id: sent?.key?.id ?? null, jid };
    } catch (error) {
      const code = statusCodeOf(error);
      const text = (error as Error)?.message ?? String(error);
      if ([401, 403, 404, 406].includes(code ?? 0) || /item-not-found|forbidden|not-acceptable|not-authorized/i.test(text)) {
        throw new PermanentSendError(
          jid.endsWith('@g.us')
            ? `WhatsApp refused the message to this group (${text}). Is the linked number still a member, and allowed to post?`
            : `WhatsApp refused the message (${text}).`,
        );
      }
      throw error;
    }
  }

  sendText(jid: string, text: string): Promise<SendResult> {
    return this.send(jid, { text });
  }

  sendDocument(jid: string, document: DocumentPayload): Promise<SendResult> {
    return this.send(jid, {
      document: document.data,
      mimetype: document.mimetype,
      fileName: document.fileName,
      caption: document.caption,
    });
  }
}
