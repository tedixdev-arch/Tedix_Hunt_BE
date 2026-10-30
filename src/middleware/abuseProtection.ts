import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import type { RequestHandler } from 'express';
import type { AbuseProtectionConfig, Budget, BudgetName } from '../config/abuseProtection.js';

interface Entry { tokens: number; updatedAt: number; expiresAt: number }

/** Bounded token buckets: full burst capacity, replenished evenly over windowMs. */
export class TokenBuckets {
  private readonly entries = new Map<string, Entry>();
  private nextExpiry = Infinity;
  constructor(private readonly maxEntries: number, private readonly now = () => performance.now()) {}
  get size() { return this.entries.size; }
  sweep() {
    const now = this.now();
    this.nextExpiry = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
      else this.nextExpiry = Math.min(this.nextExpiry, entry.expiresAt);
    }
  }
  consume(key: string, budget: Budget): number {
    const now = this.now();
    let entry = this.entries.get(key);
    if (entry && entry.expiresAt <= now) { this.entries.delete(key); entry = undefined; }
    if (!entry) {
      if (this.entries.size >= this.maxEntries && now >= this.nextExpiry) this.sweep();
      // Fail closed without evicting a live identity (which would reset its budget).
      if (this.entries.size >= this.maxEntries) return Math.max(1, Math.ceil((this.nextExpiry - now) / 1_000));
      entry = { tokens: budget.capacity, updatedAt: now, expiresAt: now };
      this.entries.set(key, entry);
    }
    entry.tokens = Math.min(budget.capacity, entry.tokens + Math.max(0, now - entry.updatedAt) * budget.capacity / budget.windowMs);
    entry.updatedAt = now;
    const allowed = entry.tokens >= 1;
    if (allowed) entry.tokens -= 1;
    entry.expiresAt = now + (budget.capacity - entry.tokens) * budget.windowMs / budget.capacity;
    this.nextExpiry = Math.min(this.nextExpiry, entry.expiresAt);
    return allowed ? 0 : Math.max(1, Math.ceil((1 - entry.tokens) * budget.windowMs / budget.capacity / 1_000));
  }
}

// Canonicalize IPv4-mapped addresses. Group IPv6 by /64 to avoid cheap suffix rotation.
export function networkIdentity(ip: string): string {
  const address = ip.split('%')[0].toLowerCase();
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6) return 'unknown';
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left, right = ''] = canonical.split('::');
  const prefix = left ? left.split(':') : [];
  const suffix = right ? right.split(':') : [];
  const parts = canonical.includes('::')
    ? [...prefix, ...Array<string>(8 - prefix.length - suffix.length).fill('0'), ...suffix]
    : prefix;
  if (parts.slice(0, 5).every((part) => parseInt(part, 16) === 0) && parseInt(parts[5], 16) === 65535) {
    const high = parseInt(parts[6], 16), low = parseInt(parts[7], 16);
    return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
  }
  return `${parts.slice(0, 4).map((part) => parseInt(part, 16).toString(16)).join(':')}::/64`;
}

const paths: Record<string, BudgetName> = {
  '/api/auth/participant/login': 'loginNetwork', '/api/auth/organizer/login': 'loginNetwork',
  '/api/auth/creator/login': 'loginNetwork', '/api/auth/admin/login': 'loginNetwork',
  '/api/auth/participant/register': 'registration',
  '/api/organizer-applications': 'registration', '/api/creator-applications': 'registration',
  '/api/auth/guest': 'guest', '/api/auth/admin/activate': 'activation',
  '/api/auth/organizer/activate-direct': 'activation', '/api/auth/creator/activate': 'activation',
  '/api/auth/refresh': 'refresh',
};

export function createAbuseProtection(config: AbuseProtectionConfig, now?: () => number) {
  const store = new TokenBuckets(config.maxEntries, now);
  const secret = randomBytes(32);
  const key = (kind: BudgetName, identity: string) => `${kind}:${createHmac('sha256', secret).update(identity).digest('hex')}`;
  // One unref'ed timer per enabled application; idle entries expire without further traffic.
  const timer = config.enabled ? setInterval(() => store.sweep(), 1_000) : undefined;
  timer?.unref();
  const stop = () => { if (timer) clearInterval(timer); };
  const reject = (res: Parameters<RequestHandler>[1], retry: number) =>
    res.set('Retry-After', String(retry)).status(429).json({ error: 'too_many_requests' });
  const budgetFor = (req: Parameters<RequestHandler>[0]) => config.enabled && req.method === 'POST'
    ? paths[req.path.toLowerCase().replace(/\/$/, '')] : undefined;
  // Before JSON parsing: malformed payloads also spend the verified network budget.
  const middleware: RequestHandler = (req, res, next) => {
    const kind = budgetFor(req);
    if (!kind) return next();
    const network = networkIdentity(req.ip ?? req.socket.remoteAddress ?? 'unknown');
    const retry = store.consume(key(kind, network), config.budgets[kind]);
    if (retry) return reject(res, retry);
    next();
  };
  const accountMiddleware: RequestHandler = (req, res, next) => {
    const kind = budgetFor(req);
    if (!kind) return next();
    if (kind === 'loginNetwork') {
      const email: unknown = req.body?.email;
      const account = typeof email === 'string' && email.length <= 1024 && email.trim()
        ? email.trim().toLowerCase() : '<malformed>';
      const retry = store.consume(key('loginAccount', account), config.budgets.loginAccount);
      if (retry) return reject(res, retry);
    }
    // Shape checks prevent malformed values reaching bcrypt/model methods. No identity lookup.
    if (kind !== 'guest' && (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body))) {
      return res.status(400).json({ error: 'invalid_input' });
    }
    if (kind === 'loginNetwork' && (typeof req.body.email !== 'string' || typeof req.body.password !== 'string')) {
      return res.status(400).json({ error: 'invalid_input' });
    }
    if (kind === 'registration' && ['email', 'password', 'name'].some((field) =>
      req.body[field] != null && typeof req.body[field] !== 'string')) {
      return res.status(400).json({ error: 'invalid_input' });
    }
    next();
  };
  return { middleware, accountMiddleware, store, stop };
}
