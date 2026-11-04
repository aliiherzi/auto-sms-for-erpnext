/**
 * Stand-in WhatsApp connection for automated tests and trying the dashboard
 * without a phone (WHATSAPP_DRIVER=fake). Nothing leaves the machine: every
 * "sent" message is kept in memory so tests can inspect it.
 */
import { EventEmitter } from 'node:events';
import {
  PermanentSendError,
  type DocumentPayload,
  type SendResult,
  type WhatsAppClient,
  type WhatsAppGroup,
  type WhatsAppState,
} from './types.js';

export interface FakeSentMessage {
  jid: string;
  text?: string;
  document?: { fileName: string; mimetype: string; size: number; caption?: string; data: Buffer };
  at: string;
}

export class FakeWhatsApp extends EventEmitter implements WhatsAppClient {
  readonly driver = 'fake' as const;
  readonly sent: FakeSentMessage[] = [];
  /** Numbers (digits) that should look like they have no WhatsApp account. */
  readonly numbersWithoutWhatsApp = new Set<string>();
  /** Make the next N sends fail with a temporary error (to test retries). */
  failNextSends = 0;
  private connected = false;
  private counter = 0;

  constructor(
    public groups: WhatsAppGroup[] = [
      { id: '120363000000000001@g.us', name: 'Management (demo)', size: 5, announce: false, isAdmin: true },
      { id: '120363000000000002@g.us', name: 'Accounts team (demo)', size: 3, announce: false, isAdmin: false },
    ],
  ) {
    super();
  }

  getState(): WhatsAppState {
    return {
      status: this.connected ? 'connected' : 'stopped',
      driver: 'fake',
      me: this.connected ? { id: '10000000000@s.whatsapp.net', phone: '10000000000', name: 'Fake WhatsApp (testing)' } : undefined,
      updatedAt: new Date().toISOString(),
    };
  }

  isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    this.connected = true;
    this.emit('state', this.getState());
    this.emit('connected');
  }

  async stop(): Promise<void> {
    this.connected = false;
    this.emit('state', this.getState());
  }

  async startLinking(): Promise<void> {
    await this.start();
  }

  async requestPairingCode(): Promise<string> {
    return 'FAKE-CODE';
  }

  async logout(): Promise<void> {
    await this.stop();
  }

  async listGroups(): Promise<WhatsAppGroup[]> {
    return this.groups;
  }

  async lookupNumber(digits: string): Promise<string | null> {
    return this.numbersWithoutWhatsApp.has(digits) ? null : `${digits}@s.whatsapp.net`;
  }

  private check(jid: string): void {
    if (!this.connected) throw new Error('WhatsApp is not connected');
    if (this.failNextSends > 0) {
      this.failNextSends--;
      throw new Error('Simulated network error');
    }
    if (jid.endsWith('@g.us') && !this.groups.some((g) => g.id === jid)) {
      throw new PermanentSendError('WhatsApp refused the message to this group (item-not-found).');
    }
  }

  async sendText(jid: string, text: string): Promise<SendResult> {
    this.check(jid);
    this.sent.push({ jid, text, at: new Date().toISOString() });
    return { id: `FAKE${++this.counter}`, jid };
  }

  async sendDocument(jid: string, document: DocumentPayload): Promise<SendResult> {
    this.check(jid);
    this.sent.push({
      jid,
      document: { fileName: document.fileName, mimetype: document.mimetype, size: document.data.length, caption: document.caption, data: document.data },
      at: new Date().toISOString(),
    });
    return { id: `FAKE${++this.counter}`, jid };
  }
}
