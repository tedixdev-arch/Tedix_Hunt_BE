import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import type { RequestHandler } from 'express';
import type { AbuseProtectionConfig, Budget, BudgetName } from '../config/abuseProtection.js';

interface Entry {
  key: string;
  tokens: number;
  updatedAt: number;
  expiresAt: number;
  heapIndex: number;
}

/** Token refill and idle retention are independent; cleanup never grants extra tokens. */
export class TokenBuckets {
  private readonly entries = new Map<string, Entry>();
  // One indexed deadline per map entry: no stale records or scans of live entries.
  private readonly deadlines: Entry[] = [];
  constructor(private readonly maxEntries: number, private readonly now = () => performance.now()) {}
  get size() { return this.entries.size; }
  get nextExpiry() { return this.deadlines[0]?.expiresAt ?? Infinity; }

  private swap(a: number, b: number) {
    [this.deadlines[a], this.deadlines[b]] = [this.deadlines[b], this.deadlines[a]];
    this.deadlines[a].heapIndex = a;
    this.deadlines[b].heapIndex = b;
  }
  private up(index: number) {
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (this.deadlines[parent].expiresAt <= this.deadlines[index].expiresAt) break;
      this.swap(parent, index); index = parent;
    }
  }
  private down(index: number) {
    for (;;) {
      const left = index * 2 + 1, right = left + 1;
      let smallest = index;
      if (left < this.deadlines.length && this.deadlines[left].expiresAt < this.deadlines[smallest].expiresAt) smallest = left;
      if (right < this.deadlines.length && this.deadlines[right].expiresAt < this.deadlines[smallest].expiresAt) smallest = right;
      if (smallest === index) return;
      this.swap(index, smallest); index = smallest;
    }
  }
  private expire(now: number) {
    while (this.nextExpiry <= now) {
      const expired = this.deadlines[0];
      const last = this.deadlines.pop()!;
      this.entries.delete(expired.key);
      if (this.deadlines.length) {
        this.deadlines[0] = last; last.heapIndex = 0; this.down(0);
      }
    }
  }
  sweep() { this.expire(this.now()); }

  consume(key: string, budget: Budget): number {
    const now = this.now();
    // Only expired roots are visited; overload cannot trigger scans of active buckets.
    this.expire(now);
    let entry = this.entries.get(key);
    if (!entry) {
      // Never evict a live identity to make room, which would reset its budget.
      if (this.entries.size >= this.maxEntries) return Math.max(1, Math.ceil((this.nextExpiry - now) / 1_000));
      entry = { key, tokens: budget.capacity, updatedAt: now, expiresAt: now + budget.windowMs, heapIndex: this.deadlines.length };
      this.entries.set(key, entry);
      this.deadlines.push(entry); this.up(entry.heapIndex);
    }
    entry.tokens = Math.min(budget.capacity, entry.tokens + Math.max(0, now - entry.updatedAt) * budget.capacity / budget.windowMs);
    entry.updatedAt = now;
    const allowed = entry.tokens >= 1;
    if (allowed) entry.tokens -= 1;
    // Conservative idle TTL: even an empty bucket is full after this much inactivity.
    // Refill continues normally before expiry; rejection does not spend another token.
    const previousExpiry = entry.expiresAt;
    entry.expiresAt = now + budget.windowMs;
    if (entry.expiresAt < previousExpiry) this.up(entry.heapIndex);
    else this.down(entry.heapIndex);
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
