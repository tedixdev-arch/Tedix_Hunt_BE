import { Router, json, type ErrorRequestHandler, type RequestHandler } from 'express';
import type { QueryConfig } from 'pg';
import { isIP } from 'node:net';
import { environment } from '../config/environment.js';
import { pool } from '../lib/postgres.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

export const developmentDatabaseBindingRouter = Router();
const blocked = (code: string) => ({ status: 'BLOCKED', code });
// Invoke existing authentication middleware while retaining a finite diagnostic response.
const sanitized = (middleware: RequestHandler): RequestHandler => (req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => json(res.statusCode === 401 || res.statusCode === 403
    ? blocked('AUTHORIZATION_REQUIRED') : body);
  return middleware(req, res, next);
};

developmentDatabaseBindingRouter.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (environment.nodeEnv !== 'development' || process.env.NODE_ENV !== 'development') {
    res.status(404).json(blocked('DEVELOPMENT_ONLY')); return;
  }
  // Use the transport peer, never Express's proxy-derived req.ip.
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
    || Object.keys(req.headers).some(h => h === 'forwarded' || h.startsWith('x-forwarded-'))) {
    res.status(403).json(blocked('DIRECT_LOOPBACK_REQUIRED')); return;
  }
  next();
}, sanitized(requireAuth), sanitized(requireRole('admin')), json({ limit: '1kb', strict: true }));

developmentDatabaseBindingRouter.post('/', async (req, res) => {
  const expected = req.body;
  if (!expected || Object.keys(expected).sort().join(',') !== 'DEV_PG_SERVER_ADDR,DEV_PG_SERVER_PORT,DEV_PG_SYSTEM_IDENTIFIER'
    || typeof expected.DEV_PG_SYSTEM_IDENTIFIER !== 'string'
    || !/^[1-9][0-9]{0,19}$/.test(expected.DEV_PG_SYSTEM_IDENTIFIER)
    || typeof expected.DEV_PG_SERVER_ADDR !== 'string' || !isIP(expected.DEV_PG_SERVER_ADDR)
    || typeof expected.DEV_PG_SERVER_PORT !== 'string' || !/^[1-9][0-9]{0,4}$/.test(expected.DEV_PG_SERVER_PORT)
    || Number(expected.DEV_PG_SERVER_PORT) > 65535) {
    res.status(400).json(blocked('INDEPENDENT_CONFIGURATION_REQUIRED')); return;
  }
  try {
    // One SELECT, one Pool connection and snapshot. No new Pool, writes, grants or process metadata.
    // inet comparison handles equivalent IPv6 spellings; names are fixed by the reviewed DEV contract.
    const query: QueryConfig & { query_timeout: number } = {
      text: `SELECT current_database() = 'tedix_hunt' AS database_match,
        current_user = 'tedix_app' AND session_user = 'tedix_app' AS role_match,
        system_identifier::text = $1 AS cluster_match,
        inet_server_addr() = $2::inet AND inet_server_port() = $3::integer AS endpoint_match
        FROM pg_catalog.pg_control_system()`,
      values: [expected.DEV_PG_SYSTEM_IDENTIFIER, expected.DEV_PG_SERVER_ADDR, expected.DEV_PG_SERVER_PORT],
      query_timeout: 5000,
    };
    const result = await pool.query(query);
    const row = result.rows[0];
    const keys = ['database_match', 'role_match', 'cluster_match', 'endpoint_match'];
    if (result.rows.length !== 1 || keys.some(k => typeof row?.[k] !== 'boolean')) {
      res.status(503).json(blocked('IDENTITY_UNAVAILABLE')); return;
    }
    const checks = Object.fromEntries(keys.map(k => [k, row[k] ? 'PASS' : 'FAIL']));
    res.json({ status: keys.every(k => row[k]) ? 'PASS' : 'FAIL', checks });
  } catch (error) {
    // Never pass PostgreSQL errors to the general development error handler or logs.
    const permission = typeof error === 'object' && error !== null && 'code' in error && error.code === '42501';
    res.status(503).json(blocked(permission ? 'PERMISSION_PG_METADATA' : 'IDENTITY_UNAVAILABLE'));
  }
});

// Keep parser errors and unsupported methods inside the sanitized diagnostic boundary.
developmentDatabaseBindingRouter.use((_req, res) => {
  res.status(405).json(blocked('METHOD_NOT_ALLOWED'));
});
const diagnosticError: ErrorRequestHandler = (_error, _req, res, _next) => {
  res.status(400).json(blocked('INVALID_REQUEST'));
};
developmentDatabaseBindingRouter.use(diagnosticError);
