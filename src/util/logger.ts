/**
 * Small human-readable logger.
 *
 * It implements the logger interface Baileys expects (level, child, trace…error),
 * prints one readable line per entry, and keeps the most recent entries in memory
 * so the dashboard can show them without anyone needing shell access.
 */

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

const LEVELS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 100,
};

export interface LogEntry {
  time: string;
  level: Exclude<LogLevel, 'silent'>;
  scope: string;
  message: string;
}

export interface Logger {
  level: string;
  child(bindings: Record<string, unknown>): Logger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  fatal(obj: unknown, msg?: string): void;
}

const MAX_RECENT = 300;
const recent: LogEntry[] = [];

/** Most recent log entries (info and above), newest last. */
export function recentLogs(): LogEntry[] {
  return recent.slice();
}

function describe(obj: unknown, msg?: string): string {
  if (typeof obj === 'string') return msg ? `${obj} ${msg}` : obj;
  if (obj instanceof Error) return msg ? `${msg}: ${obj.message}` : obj.message;
  if (obj && typeof obj === 'object') {
    const record = obj as Record<string, unknown>;
    const err = record.err ?? record.error;
    const errText = err instanceof Error ? err.message : err ? String(err) : '';
    const rest = Object.entries(record)
      .filter(([k]) => k !== 'err' && k !== 'error')
      .map(([k, v]) => `${k}=${typeof v === 'object' ? safeJson(v) : String(v)}`)
      .join(' ');
    return [msg, errText && `error="${errText}"`, rest].filter(Boolean).join(' ');
  }
  return msg ?? String(obj);
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  } catch {
    return '[object]';
  }
}

class ConsoleLogger implements Logger {
  private threshold: number;

  constructor(
    public level: string,
    private scope: string,
    private keepRecent: boolean,
  ) {
    this.threshold = LEVELS[(level as LogLevel) in LEVELS ? (level as LogLevel) : 'info'];
  }

  child(bindings: Record<string, unknown>): Logger {
    const name = typeof bindings.scope === 'string' ? bindings.scope : typeof bindings.class === 'string' ? bindings.class : '';
    const scope = name ? (this.scope ? `${this.scope}:${name}` : name) : this.scope;
    return new ConsoleLogger(this.level, scope, this.keepRecent);
  }

  private write(level: Exclude<LogLevel, 'silent'>, obj: unknown, msg?: string): void {
    if (LEVELS[level] < this.threshold) return;
    const entry: LogEntry = { time: new Date().toISOString(), level, scope: this.scope, message: describe(obj, msg) };
    const line = `${entry.time} ${level.toUpperCase().padEnd(5)} ${entry.scope ? `[${entry.scope}] ` : ''}${entry.message}`;
    if (LEVELS[level] >= LEVELS.warn) console.error(line);
    else console.log(line);
    if (this.keepRecent && LEVELS[level] >= LEVELS.info) {
      recent.push(entry);
      if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
    }
  }

  trace(obj: unknown, msg?: string) {
    this.write('trace', obj, msg);
  }
  debug(obj: unknown, msg?: string) {
    this.write('debug', obj, msg);
  }
  info(obj: unknown, msg?: string) {
    this.write('info', obj, msg);
  }
  warn(obj: unknown, msg?: string) {
    this.write('warn', obj, msg);
  }
  error(obj: unknown, msg?: string) {
    this.write('error', obj, msg);
  }
  fatal(obj: unknown, msg?: string) {
    this.write('fatal', obj, msg);
  }
}

export function createLogger(level: string, scope = '', keepRecent = true): Logger {
  return new ConsoleLogger(level, scope, keepRecent);
}

/** A logger that discards everything (useful in tests). */
export const silentLogger: Logger = createLogger('silent', '', false);
