import { randomBytes } from 'node:crypto';

// Loaded only by Vitest, before application imports. Never reuse an inherited key.
// Runtime validation has no test-mode bypass or fallback.
process.env.JWT_SECRET = randomBytes(32).toString('hex');
