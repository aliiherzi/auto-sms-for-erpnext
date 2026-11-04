/** Password login for the dashboard: an HMAC-signed session cookie, no database needed. */
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const COOKIE = 'asms_session';
const MAX_AGE_MS = 7 * 24 * 3_600_000;

export class Auth {
  private readonly key: Buffer;
  private failures = new Map<string, { count: number; until: number }>();

  constructor(
    private readonly password: string,
    sessionSecret?: string,
  ) {
    this.key = crypto.createHash('sha256').update(`auto-sms-session:${sessionSecret || password}`).digest();
  }

  checkPassword(candidate: string): boolean {
    const a = crypto.createHash('sha256').update(candidate).digest();
    const b = crypto.createHash('sha256').update(this.password).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /** Simple brute-force protection: 5 wrong passwords → wait 5 minutes. */
  isLockedOut(ip: string): boolean {
    const entry = this.failures.get(ip);
    return Boolean(entry && entry.count >= 5 && entry.until > Date.now());
  }

  recordFailure(ip: string): void {
    const entry = this.failures.get(ip) ?? { count: 0, until: 0 };
    if (entry.until < Date.now()) entry.count = 0;
    entry.count++;
    entry.until = Date.now() + 5 * 60_000;
    this.failures.set(ip, entry);
  }

  clearFailures(ip: string): void {
    this.failures.delete(ip);
  }

  private sign(payload: string): string {
    return crypto.createHmac('sha256', this.key).update(payload).digest('base64url');
  }

  /** Sets the session cookie (same-site dashboard) and returns the same token for apps on other sites. */
  issue(res: Response, secure: boolean): string {
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + MAX_AGE_MS })).toString('base64url');
    const token = `${payload}.${this.sign(payload)}`;
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure, maxAge: MAX_AGE_MS, path: '/' });
    return token;
  }

  clear(res: Response): void {
    res.clearCookie(COOKIE, { path: '/' });
  }

  /** Accepts the session cookie, or "Authorization: Bearer <token>" from the phone app on GitHub Pages. */
  isValid(req: Request): boolean {
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const token = bearer ?? parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return false;
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return false;
    const expected = this.sign(payload);
    if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return false;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
      return typeof data.exp === 'number' && data.exp > Date.now();
    } catch {
      return false;
    }
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (this.isValid(req)) return next();
      res.status(401).json({ error: 'Please log in' });
    };
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key) out[key] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

/** Verifies ERPNext's webhook signature: base64(HMAC-SHA256(secret, raw body)). */
export function verifyFrappeSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
