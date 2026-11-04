/**
 * Outbox: sends queued WhatsApp messages one by one, separately for each linked number.
 *
 *  - waits while a number is disconnected (nothing is lost)
 *  - pauses between messages (settings.general.sendDelaySeconds + a little jitter)
 *  - retries temporary failures with back-off, gives up on permanent ones
 */
import type { Database, MessageRow, NewMessage } from '../db/database.js';
import type { Logger } from '../util/logger.js';
import { isJid, normalizePhone } from '../util/phone.js';
import type { WhatsAppManager } from '../whatsapp/manager.js';
import { PermanentSendError } from '../whatsapp/types.js';

const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000];
const MAX_QUEUE_AGE_MS = 72 * 3_600_000;

export interface OutboxOptions {
  db: Database;
  whatsapp: WhatsAppManager;
  logger: Logger;
  /** Returns the current pause between messages in ms. */
  delayMs: () => number;
  /** Returns the default country code for numbers that need it. */
  countryCode?: () => string;
}

interface Worker {
  running: boolean;
  wake?: () => void;
  done: Promise<void>;
}

export class Outbox {
  private running = false;
  private workers = new Map<string, Worker>();
  private readonly log: Logger;

  constructor(private readonly options: OutboxOptions) {
    this.log = options.logger.child({ scope: 'outbox' });
    options.whatsapp.on('connected', (accountId: string) => this.kick(accountId));
    options.whatsapp.on('removed', (accountId: string) => {
      this.stopWorker(accountId);
      const failed = options.db.failQueuedForAccount(accountId, 'This WhatsApp number was removed before the message could be sent.');
      if (failed) this.log.warn(`${failed} waiting message(s) of a removed WhatsApp number were marked as failed`);
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.options.db.resetSending();
    this.sync();
  }

  /** One worker per linked number. Call after numbers are added or removed. */
  sync(): void {
    if (!this.running) return;
    const ids = new Set(this.options.whatsapp.ids());
    for (const id of ids) if (!this.workers.has(id)) this.startWorker(id);
    for (const id of [...this.workers.keys()]) if (!ids.has(id)) this.stopWorker(id);
  }

  async stop(): Promise<void> {
    this.running = false;
    const pending = [...this.workers.keys()].map((id) => this.stopWorker(id));
    await Promise.all(pending);
  }

  /** Queue a message and wake its sender. Returns the message id (null if it was a duplicate). */
  enqueue(message: NewMessage): number | null {
    const id = this.options.db.addMessage(message);
    if (id !== null && (message.status ?? 'queued') === 'queued') this.kick(message.accountId);
    return id;
  }

  retry(id: number): boolean {
    const ok = this.options.db.requeue(id);
    if (ok) this.kick(this.options.db.getMessage(id)?.account_id);
    return ok;
  }

  kick(accountId?: string): void {
    const targets = accountId ? [this.workers.get(accountId)] : [...this.workers.values()];
    for (const worker of targets) {
      const wake = worker?.wake;
      if (worker) worker.wake = undefined;
      wake?.();
    }
  }

  private startWorker(accountId: string): void {
    const worker: Worker = { running: true, done: Promise.resolve() };
    this.workers.set(accountId, worker);
    worker.done = this.loop(accountId, worker);
  }

  private stopWorker(accountId: string): Promise<void> {
    const worker = this.workers.get(accountId);
    if (!worker) return Promise.resolve();
    worker.running = false;
    this.workers.delete(accountId);
    worker.wake?.();
    return worker.done;
  }

  private sleep(worker: Worker, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        worker.wake = undefined;
        resolve();
      }, ms);
      timer.unref();
      worker.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private async loop(accountId: string, worker: Worker): Promise<void> {
    while (worker.running && this.running) {
      try {
        if (!this.options.whatsapp.isConnected(accountId)) {
          await this.sleep(worker, 5_000);
          continue;
        }
        const message = this.options.db.nextQueuedMessage(accountId);
        if (!message) {
          await this.sleep(worker, 15_000);
          continue;
        }
        await this.deliver(message);
        // Pause before the next message so we don't look like a spam bot.
        const delay = this.options.delayMs() + Math.floor(Math.random() * 1500);
        await new Promise((resolve) => setTimeout(resolve, delay).unref());
      } catch (error) {
        this.log.error({ err: error }, 'Outbox loop error');
        await this.sleep(worker, 5_000);
      }
    }
  }

  /** Sends one message now (used by the workers; exposed for tests). */
  async deliver(message: MessageRow): Promise<void> {
    const { db, whatsapp } = this.options;
    const ageMs = Date.now() - new Date(message.created_at).getTime();
    if (ageMs > MAX_QUEUE_AGE_MS) {
      // Don't surprise customers with week-old invoices after a long outage.
      db.markFailed(message.id, 'Expired: WhatsApp was not connected for more than 3 days. Use "Retry" to send it anyway.');
      return;
    }
    const client = whatsapp.get(message.account_id);
    if (!client) {
      db.markFailed(message.id, `The WhatsApp number "${message.account_id}" no longer exists.`);
      return;
    }
    db.markSending(message.id);
    const attempt = message.attempts + 1;
    const from = whatsapp.label(message.account_id);
    try {
      const jid = await this.resolveJid(message.account_id, message.recipient);
      let result;
      if (message.attachment_id) {
        const file = db.getAttachment(message.attachment_id);
        if (!file) throw new PermanentSendError('The attached file is no longer available. Resend the invoice from the dashboard.');
        result = await client.sendDocument(jid, {
          data: Buffer.from(file.data),
          fileName: file.file_name,
          mimetype: file.mimetype,
          caption: message.body,
        });
      } else {
        result = await client.sendText(jid, message.body);
      }
      db.markSent(message.id, result.id);
      this.log.info(`Sent ${message.kind} message #${message.id} from "${from}" to ${message.recipient_name || message.recipient}`);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (error instanceof PermanentSendError || attempt > RETRY_DELAYS_MS.length) {
        db.markFailed(message.id, text);
        this.log.warn(`Message #${message.id} to ${message.recipient_name || message.recipient} failed: ${text}`);
      } else {
        const next = new Date(Date.now() + RETRY_DELAYS_MS[attempt - 1]);
        db.markRetry(message.id, text, next);
        this.log.warn(`Message #${message.id} failed (attempt ${attempt}), will retry at ${next.toISOString()}: ${text}`);
      }
    }
  }

  private async resolveJid(accountId: string, recipient: string): Promise<string> {
    if (isJid(recipient)) return recipient;
    const digits = normalizePhone(recipient.startsWith('+') ? recipient : `+${recipient}`, this.options.countryCode?.() ?? '');
    if (!digits) throw new PermanentSendError(`"${recipient}" is not a valid phone number`);
    const client = this.options.whatsapp.get(accountId);
    const jid = client ? await client.lookupNumber(digits) : null;
    if (!jid) throw new PermanentSendError(`+${digits} does not have a WhatsApp account`);
    return jid;
  }
}
