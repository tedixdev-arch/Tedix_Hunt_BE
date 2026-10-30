import { isIP } from 'node:net';

export type BudgetName = 'loginNetwork' | 'loginAccount' | 'registration' | 'guest' | 'activation' | 'refresh';
export interface Budget { capacity: number; windowMs: number }
export interface AbuseProtectionConfig {
  enabled: boolean;
  trustedProxies: string[];
  maxEntries: number;
  budgets: Record<BudgetName, Budget>;
}

// Provisional development values. Enabling in production requires operator/PO approval.
const defaults: Record<BudgetName, Budget> = {
  loginNetwork: { capacity: 120, windowMs: 60_000 },
  loginAccount: { capacity: 10, windowMs: 300_000 },
  registration: { capacity: 60, windowMs: 60_000 },
  guest: { capacity: 80, windowMs: 60_000 },
  activation: { capacity: 60, windowMs: 60_000 },
  refresh: { capacity: 240, windowMs: 60_000 },
};
const names: Record<BudgetName, string> = {
  loginNetwork: 'LOGIN_NETWORK', loginAccount: 'LOGIN_ACCOUNT', registration: 'REGISTRATION',
  guest: 'GUEST', activation: 'ACTIVATION', refresh: 'REFRESH',
};

export function readAbuseProtectionConfig(env: NodeJS.ProcessEnv = process.env): AbuseProtectionConfig {
  const integer = (key: string, fallback: number, maximum: number) => {
    const value = env[key];
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > maximum) {
      throw new Error(`Invalid ${key}`);
    }
    return Number(value);
  };
  if (env.AUTH_ABUSE_ENABLED !== undefined && !['true', 'false'].includes(env.AUTH_ABUSE_ENABLED)) {
    throw new Error('Invalid AUTH_ABUSE_ENABLED');
  }
  // Only literal IP addresses/CIDRs; never Boolean true, numeric hop trust or broad aliases.
  const trustedProxies = env.AUTH_TRUSTED_PROXIES?.split(',').map((value) => value.trim()) ?? [];
  if (trustedProxies.some((value) => {
    const [address, prefix, extra] = value.split('/');
    const version = isIP(address);
    return !version || extra !== undefined || (prefix !== undefined &&
      (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (version === 4 ? 32 : 128)));
  })) {
    throw new Error('Invalid AUTH_TRUSTED_PROXIES: provide explicit addresses/CIDRs');
  }
  const budgets = Object.fromEntries(Object.entries(defaults).map(([name, budget]) => [name, {
    capacity: integer(`AUTH_ABUSE_${names[name as BudgetName]}_CAPACITY`, budget.capacity, 1_000_000),
    windowMs: integer(`AUTH_ABUSE_${names[name as BudgetName]}_WINDOW_MS`, budget.windowMs, 86_400_000),
  }])) as Record<BudgetName, Budget>;
  return {
    enabled: env.AUTH_ABUSE_ENABLED === 'true', trustedProxies,
    maxEntries: integer('AUTH_ABUSE_MAX_ENTRIES', 20_000, 100_000), budgets,
  };
}
