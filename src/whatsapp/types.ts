import type { EventEmitter } from 'node:events';

export type WhatsAppStatus =
  /** not started yet */
  | 'stopped'
  /** opening the connection */
  | 'connecting'
  /** waiting for the QR code to be scanned / pairing code to be entered */
  | 'waiting_for_scan'
  /** QR session expired; the dashboard can start a new one */
  | 'not_linked'
  | 'connected'
  /** temporarily offline, will reconnect */
  | 'reconnecting'
  /** needs attention (see lastError) */
  | 'error';

export interface WhatsAppState {
  status: WhatsAppStatus;
  /** data: URL of the current QR code image */
  qrDataUrl?: string;
  pairingCode?: string;
  /** the linked account */
  me?: { id: string; phone: string; name?: string };
  lastError?: string;
  driver: 'baileys' | 'fake';
  updatedAt: string;
}

export interface WhatsAppGroup {
  id: string;
  name: string;
  size: number;
  /** only admins can post */
  announce: boolean;
  /** whether the linked number is an admin of the group */
  isAdmin: boolean;
}

export interface SendResult {
  id: string | null;
  /** the JID the message went to */
  jid: string;
}

export interface DocumentPayload {
  data: Buffer;
  fileName: string;
  mimetype: string;
  caption?: string;
}

/** Thrown for problems that retrying won't fix (number not on WhatsApp, bad group…). */
export class PermanentSendError extends Error {}

export interface WhatsAppClient extends EventEmitter {
  readonly driver: 'baileys' | 'fake';
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): WhatsAppState;
  isConnected(): boolean;
  /** Starts a fresh linking session (new QR code). */
  startLinking(): Promise<void>;
  /** Link with phone number instead of QR: returns the 8 character code to type in WhatsApp. */
  requestPairingCode(phone: string): Promise<string>;
  logout(): Promise<void>;
  listGroups(force?: boolean): Promise<WhatsAppGroup[]>;
  /** JID for a phone number, or null when that number has no WhatsApp account. */
  lookupNumber(digits: string): Promise<string | null>;
  sendText(jid: string, text: string): Promise<SendResult>;
  sendDocument(jid: string, document: DocumentPayload): Promise<SendResult>;
}
