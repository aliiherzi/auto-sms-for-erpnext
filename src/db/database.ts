/**
 * Local SQLite storage (Node's built-in node:sqlite, no native build needed).
 *
 *  - messages:        every WhatsApp message we queue, with status and errors (the outbox)
 *  - attachments:     PDFs/CSVs waiting to be sent
 *  - processed_docs:  invoices we have already handled, so nothing is sent twice
 *  - report_runs:     history of scheduled report runs
 *  - kv:              checkpoints for the invoice watcher
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type MessageStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'skipped';
export type MessageKind = 'invoice' | 'report' | 'test';
export type Audience = 'party' | 'group' | 'test' | 'direct';

export interface MessageRow {
  id: number;
  /** Which linked WhatsApp number sends it. */
  account_id: string;
  kind: MessageKind;
  ref_doctype: string | null;
  ref_name: string | null;
  audience: Audience;
  recipient: string;
  recipient_name: string | null;
  body: string;
  attachment_id: number | null;
  attachment_name: string | null;
  status: MessageStatus;
  error: string | null;
  attempts: number;
  next_attempt_at: string | null;
  wa_message_id: string | null;
  dedupe_key: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

export interface NewMessage {
  accountId: string;
  kind: MessageKind;
  refDoctype?: string | null;
  refName?: string | null;
  audience: Audience;
  recipient: string;
  recipientName?: string | null;
  body: string;
  attachmentId?: number | null;
  attachmentName?: string | null;
  status?: MessageStatus;
  error?: string | null;
  dedupeKey?: string | null;
}

export interface AttachmentRow {
  id: number;
  file_name: string;
  mimetype: string;
  data: Uint8Array;
  created_at: string;
}

export type ProcessedStatus = 'done' | 'skipped' | 'retry' | 'failed';

export interface ProcessedDoc {
  doctype: string;
  name: string;
  status: ProcessedStatus;
  detail: string | null;
  attempts: number;
  updated_at: string;
}

export interface ReportRun {
  id: number;
  report_id: string;
  trigger: string;
  status: 'ok' | 'empty' | 'error';
  detail: string | null;
  started_at: string;
  finished_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT NOT NULL,
  mimetype TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL DEFAULT 'main',
  kind TEXT NOT NULL,
  ref_doctype TEXT,
  ref_name TEXT,
  audience TEXT NOT NULL,
  recipient TEXT NOT NULL,
  recipient_name TEXT,
  body TEXT NOT NULL,
  attachment_id INTEGER,
  attachment_name TEXT,
  status TEXT NOT NULL,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  wa_message_id TEXT,
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_messages_ref ON messages(ref_doctype, ref_name);
CREATE TABLE IF NOT EXISTS processed_docs (
  doctype TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (doctype, name)
);
CREATE TABLE IF NOT EXISTS report_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_report_runs ON report_runs(report_id, id);
`;

const now = () => new Date().toISOString();

export class Database {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    const columns = this.db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'account_id')) {
      this.db.exec("ALTER TABLE messages ADD COLUMN account_id TEXT NOT NULL DEFAULT 'main'");
    }
  }

  close(): void {
    this.db.close();
  }

  // -- key/value ------------------------------------------------------------

  getKv(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setKv(key: string, value: string): void {
    this.db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // -- attachments ------------------------------------------------------------

  addAttachment(fileName: string, mimetype: string, data: Uint8Array): number {
    const result = this.db
      .prepare('INSERT INTO attachments(file_name, mimetype, data, created_at) VALUES(?, ?, ?, ?)')
      .run(fileName, mimetype, data, now());
    return Number(result.lastInsertRowid);
  }

  getAttachment(id: number): AttachmentRow | null {
    return (this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as unknown as AttachmentRow | undefined) ?? null;
  }

  /** Removes files that no pending message needs any more. */
  pruneAttachments(olderThanHours = 48): number {
    const cutoff = new Date(Date.now() - olderThanHours * 3_600_000).toISOString();
    const result = this.db
      .prepare(
        `DELETE FROM attachments WHERE created_at < ? AND id NOT IN (
           SELECT attachment_id FROM messages WHERE attachment_id IS NOT NULL AND status IN ('queued','sending'))`,
      )
      .run(cutoff);
    return Number(result.changes);
  }

  // -- messages ---------------------------------------------------------------

  /** Inserts a message. Returns null when a message with the same dedupe key already exists. */
  addMessage(message: NewMessage): number | null {
    const ts = now();
    const result = this.db
      .prepare(
        `INSERT INTO messages(account_id, kind, ref_doctype, ref_name, audience, recipient, recipient_name, body, attachment_id,
           attachment_name, status, error, dedupe_key, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(dedupe_key) DO NOTHING`,
      )
      .run(
        message.accountId,
        message.kind,
        message.refDoctype ?? null,
        message.refName ?? null,
        message.audience,
        message.recipient,
        message.recipientName ?? null,
        message.body,
        message.attachmentId ?? null,
        message.attachmentName ?? null,
        message.status ?? 'queued',
        message.error ?? null,
        message.dedupeKey ?? null,
        ts,
        ts,
      );
    return result.changes ? Number(result.lastInsertRowid) : null;
  }

  getMessage(id: number): MessageRow | null {
    return (this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as unknown as MessageRow | undefined) ?? null;
  }

  /** Next message due for one WhatsApp number (or for any number when accountId is omitted). */
  nextQueuedMessage(accountId?: string): MessageRow | null {
    const forAccount = accountId === undefined ? '' : 'AND account_id = ?';
    const params: string[] = [now()];
    if (accountId !== undefined) params.push(accountId);
    return (
      (this.db
        .prepare(
          `SELECT * FROM messages WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ${forAccount}
           ORDER BY id LIMIT 1`,
        )
        .get(...params) as unknown as MessageRow | undefined) ?? null
    );
  }

  /** When a WhatsApp number is removed, its waiting messages can't be sent any more. */
  failQueuedForAccount(accountId: string, reason: string): number {
    const result = this.db
      .prepare(`UPDATE messages SET status = 'failed', error = ?, next_attempt_at = NULL, updated_at = ? WHERE account_id = ? AND status IN ('queued','sending')`)
      .run(reason, now(), accountId);
    return Number(result.changes);
  }

  markSending(id: number): void {
    this.db.prepare(`UPDATE messages SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ?`).run(now(), id);
  }

  markSent(id: number, waMessageId: string | null, recipient?: string): void {
    const ts = now();
    this.db
      .prepare(`UPDATE messages SET status = 'sent', error = NULL, wa_message_id = ?, sent_at = ?, updated_at = ?, recipient = COALESCE(?, recipient) WHERE id = ?`)
      .run(waMessageId, ts, ts, recipient ?? null, id);
  }

  markFailed(id: number, error: string): void {
    this.db.prepare(`UPDATE messages SET status = 'failed', error = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?`).run(error, now(), id);
  }

  markRetry(id: number, error: string, nextAttemptAt: Date): void {
    this.db
      .prepare(`UPDATE messages SET status = 'queued', error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`)
      .run(error, nextAttemptAt.toISOString(), now(), id);
  }

  /** Puts a failed/skipped message back in the queue (it counts as newly queued). */
  requeue(id: number): boolean {
    const ts = now();
    const result = this.db
      .prepare(
        `UPDATE messages SET status = 'queued', error = NULL, next_attempt_at = NULL, attempts = 0, created_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('failed','skipped') AND recipient <> '-'`,
      )
      .run(ts, ts, id);
    return result.changes > 0;
  }

  /** After a crash, messages stuck in "sending" go back to the queue. */
  resetSending(): void {
    this.db.prepare(`UPDATE messages SET status = 'queued', updated_at = ? WHERE status = 'sending'`).run(now());
  }

  listMessages(options: { status?: string; kind?: string; search?: string; limit?: number; offset?: number } = {}): { rows: MessageRow[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      where.push('status = ?');
      params.push(options.status);
    }
    if (options.kind) {
      where.push('kind = ?');
      params.push(options.kind);
    }
    if (options.search) {
      where.push('(ref_name LIKE ? OR recipient LIKE ? OR recipient_name LIKE ? OR body LIKE ?)');
      const like = `%${options.search}%`;
      params.push(like, like, like, like);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM messages ${clause}`).get(...params) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT * FROM messages ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, options.limit ?? 50, options.offset ?? 0) as unknown as MessageRow[];
    return { rows, total };
  }

  messageCounts(): Record<MessageStatus, number> {
    const counts: Record<MessageStatus, number> = { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
    for (const row of this.db.prepare('SELECT status, COUNT(*) AS n FROM messages GROUP BY status').all() as Array<{ status: MessageStatus; n: number }>) {
      counts[row.status] = row.n;
    }
    return counts;
  }

  messagesForDoc(doctype: string, name: string): MessageRow[] {
    return this.db.prepare('SELECT * FROM messages WHERE ref_doctype = ? AND ref_name = ? ORDER BY id').all(doctype, name) as unknown as MessageRow[];
  }

  // -- processed invoices -------------------------------------------------------

  getProcessed(doctype: string, name: string): ProcessedDoc | null {
    return (this.db.prepare('SELECT * FROM processed_docs WHERE doctype = ? AND name = ?').get(doctype, name) as unknown as ProcessedDoc | undefined) ?? null;
  }

  setProcessed(doctype: string, name: string, status: ProcessedStatus, detail: string | null = null, attempts?: number): void {
    this.db
      .prepare(
        `INSERT INTO processed_docs(doctype, name, status, detail, attempts, updated_at) VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(doctype, name) DO UPDATE SET status = excluded.status, detail = excluded.detail,
           attempts = excluded.attempts, updated_at = excluded.updated_at`,
      )
      .run(doctype, name, status, detail, attempts ?? 0, now());
  }

  docsToRetry(limit = 20): ProcessedDoc[] {
    return this.db.prepare(`SELECT * FROM processed_docs WHERE status = 'retry' ORDER BY updated_at LIMIT ?`).all(limit) as unknown as ProcessedDoc[];
  }

  // -- report runs -------------------------------------------------------------

  startReportRun(reportId: string, trigger: string): number {
    const result = this.db
      .prepare(`INSERT INTO report_runs(report_id, trigger, status, started_at) VALUES(?, ?, 'ok', ?)`)
      .run(reportId, trigger, now());
    return Number(result.lastInsertRowid);
  }

  finishReportRun(id: number, status: ReportRun['status'], detail: string | null): void {
    this.db.prepare('UPDATE report_runs SET status = ?, detail = ?, finished_at = ? WHERE id = ?').run(status, detail, now(), id);
  }

  lastReportRuns(): Record<string, ReportRun> {
    const rows = this.db
      .prepare(`SELECT r.* FROM report_runs r JOIN (SELECT report_id, MAX(id) AS id FROM report_runs GROUP BY report_id) last ON last.id = r.id`)
      .all() as unknown as ReportRun[];
    return Object.fromEntries(rows.map((r) => [r.report_id, r]));
  }
}
