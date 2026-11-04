/**
 * Outbox: sends queued WhatsApp messages one by one.
 *
 *  - waits while WhatsApp is disconnected (nothing is lost)
 *  - pauses between messages (settings.general.sendDelaySeconds + a little jitter)
 *  - retries temporary failures with back-off, gives up on permanent ones
 */
import type { Database, MessageRow, NewMessage } from '../db/database.js';
import type { Logger } from '../util/logger.js';
import { isJid, normalizePhone } from '../util/phone.js';
import { PermanentSendError, type WhatsAppClient } from '../whatsapp/types.js';

const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000];
const MAX_QUEUE_AGE_MS = 72 * 3_600_000;

export interface OutboxOptions {
  db: Database;
  whatsapp: WhatsAppClient;
  logger: Logger;
  /** Returns the current pause between messages in ms. */
  delayMs: () => number;
  /** Returns the default country code for numbers that need it. */
  countryCode?: () => string;
}

export class Outbox {
  private running = false;
  private wakeUp?: () => void;
  private loopPromise?: Promise<void>;
  private readonly log: Logger;

  constructor(private readonly options: OutboxOptions) {
    this.log = options.logger.child({ scope: 'outbox' });
    options.whatsapp.on('connected', () => this.kick());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.options.db.resetSending();
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.kick();
    await this.loopPromise;
  }

  /** Queue a message and wake the sender. Returns the message id (null if it was a duplicate). */
  enqueue(message: NewMessage): number | null {
    const id = this.options.db.addMessage(message);
    if (id !== null && (message.status ?? 'queued') === 'queued') this.kick();
    return id;
  }

  retry(id: number): boolean {
    const ok = this.options.db.requeue(id);
    if (ok) this.kick();
    return ok;
  }

  kick(): void {
    const wake = this.wakeUp;
    this.wakeUp = undefined;
    wake?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeUp = undefined;
        resolve();
      }, ms);
      timer.unref();
      this.wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        if (!this.options.whatsapp.isConnected()) {
          await this.sleep(5_000);
          continue;
        }
        const message = this.options.db.nextQueuedMessage();
        if (!message) {
          await this.sleep(15_000);
          continue;
        }
        await this.deliver(message);
        // Pause before the next message so we don't look like a spam bot.
        const delay = this.options.delayMs() + Math.floor(Math.random() * 1500);
        await new Promise((resolve) => setTimeout(resolve, delay).unref());
      } catch (error) {
        this.log.error({ err: error }, 'Outbox loop error');
        await this.sleep(5_000);
      }
    }
  }

  /** Sends one message now (used by the loop; exposed for tests). */
  async deliver(message: MessageRow): Promise<void> {
    const { db, whatsapp } = this.options;
    const ageMs = Date.now() - new Date(message.created_at).getTime();
    if (ageMs > MAX_QUEUE_AGE_MS) {
      // Don't surprise customers with week-old invoices after a long outage.
      db.markFailed(message.id, 'Expired: WhatsApp was not connected for more than 3 days. Use "Retry" to send it anyway.');
      return;
    }
    db.markSending(message.id);
    const attempt = message.attempts + 1;
    try {
      const jid = await this.resolveJid(message.recipient);
      let result;
      if (message.attachment_id) {
        const file = db.getAttachment(message.attachment_id);
        if (!file) throw new PermanentSendError('The attached file is no longer available. Resend the invoice from the dashboard.');
        result = await whatsapp.sendDocument(jid, {
          data: Buffer.from(file.data),
          fileName: file.file_name,
          mimetype: file.mimetype,
          caption: message.body,
        });
      } else {
        result = await whatsapp.sendText(jid, message.body);
      }
      db.markSent(message.id, result.id);
      this.log.info(`Sent ${message.kind} message #${message.id} to ${message.recipient_name || message.recipient}`);
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

  private async resolveJid(recipient: string): Promise<string> {
    if (isJid(recipient)) return recipient;
    const digits = normalizePhone(recipient.startsWith('+') ? recipient : `+${recipient}`, this.options.countryCode?.() ?? '');
    if (!digits) throw new PermanentSendError(`"${recipient}" is not a valid phone number`);
    const jid = await this.options.whatsapp.lookupNumber(digits);
    if (!jid) throw new PermanentSendError(`+${digits} does not have a WhatsApp account`);
    return jid;
  }
}
