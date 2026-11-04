/**
 * Keeps one WhatsApp connection per linked number ("account").
 * Accounts come from settings.whatsapp.accounts; each has its own session folder.
 */
import { EventEmitter } from 'node:events';
import type { WhatsAppAccount } from '../config/settings.js';
import type { Logger } from '../util/logger.js';
import type { WhatsAppClient, WhatsAppState } from './types.js';

export interface AccountStatus {
  id: string;
  label: string;
  state: WhatsAppState;
}

export class WhatsAppManager extends EventEmitter {
  private clients = new Map<string, WhatsAppClient>();
  private labels = new Map<string, string>();
  private readonly log: Logger;

  constructor(
    private readonly factory: (accountId: string) => WhatsAppClient,
    logger: Logger,
  ) {
    super();
    this.log = logger.child({ scope: 'whatsapp' });
  }

  /** Starts connections for new accounts and stops the ones that were removed. */
  async sync(accounts: WhatsAppAccount[]): Promise<void> {
    for (const account of accounts) {
      this.labels.set(account.id, account.label || account.id);
      if (this.clients.has(account.id)) continue;
      const client = this.factory(account.id);
      client.on('connected', () => this.emit('connected', account.id));
      client.on('state', () => this.emit('state', account.id));
      this.clients.set(account.id, client);
      await client.start().catch((error) => this.log.error({ err: error }, `WhatsApp "${this.label(account.id)}" failed to start`));
    }
    for (const [id, client] of [...this.clients]) {
      if (accounts.some((a) => a.id === id)) continue;
      await client.stop().catch(() => undefined);
      this.clients.delete(id);
      this.labels.delete(id);
      this.emit('removed', id);
    }
  }

  get(accountId: string): WhatsAppClient | undefined {
    return this.clients.get(accountId);
  }

  ids(): string[] {
    return [...this.clients.keys()];
  }

  label(accountId: string): string {
    return this.labels.get(accountId) ?? accountId;
  }

  isConnected(accountId: string): boolean {
    return this.clients.get(accountId)?.isConnected() ?? false;
  }

  list(): AccountStatus[] {
    return [...this.clients.entries()].map(([id, client]) => ({ id, label: this.label(id), state: client.getState() }));
  }

  /** Unlinks the number from WhatsApp (best effort) before the account is deleted. */
  async unlink(accountId: string): Promise<void> {
    const client = this.clients.get(accountId);
    if (client) await client.logout().catch((error) => this.log.warn({ err: error }, 'Unlink failed'));
  }

  async stopAll(): Promise<void> {
    for (const client of this.clients.values()) await client.stop().catch(() => undefined);
  }
}
