const user = {
  type: 'object', required: ['id', 'email', 'displayName'],
  properties: { id: { type: 'string', format: 'uuid' }, email: { type: 'string', format: 'email' }, displayName: { type: 'string', nullable: true } },
};
const session = {
  type: 'object', required: ['user', 'accessToken', 'tokenType', 'expiresIn'],
  properties: { user, accessToken: { type: 'string' }, tokenType: { type: 'string', enum: ['Bearer'] }, expiresIn: { type: 'integer', maximum: 900 } },
};
const csrf = { in: 'header', name: 'X-TedixHunt-CSRF', required: true, schema: { type: 'string', enum: ['1'] } };
const failures = {
  400: { description: 'Invalid request' }, 401: { description: 'Missing, invalid, expired or revoked credentials' },
  403: { description: 'Missing CSRF header or disallowed Origin' }, 429: { description: 'Too many attempts' }, 503: { description: 'Authentication storage temporarily unavailable' },
};
const sessionResponse = {
  description: 'Access token in JSON; refresh token only in an HttpOnly, SameSite=Strict cookie (Secure in production).',
  headers: { 'Set-Cookie': { schema: { type: 'string' }, description: 'Production cookie: __Host-tedixhunt_refresh; development: tedixhunt_refresh' } },
  content: { 'application/json': { schema: session } },
};
const accountBody = (registration: boolean) => ({
  required: true,
  content: { 'application/json': { schema: {
    type: 'object', additionalProperties: false, required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email', maxLength: 254 },
      password: { type: 'string', format: 'password', minLength: registration ? 15 : 1, maxLength: 128 },
      ...(registration ? { displayName: { type: 'string', nullable: true, maxLength: 120 } } : {}),
    },
  } } },
});

export const authPaths = {
  '/api/auth/register': { post: { tags: ['PostgreSQL Auth'], summary: 'Create an account and session', parameters: [csrf], requestBody: accountBody(true), responses: { ...failures, 201: sessionResponse, 409: { description: 'Email unavailable' } } } },
  '/api/auth/login': { post: { tags: ['PostgreSQL Auth'], summary: 'Sign in with email and password', parameters: [csrf], requestBody: accountBody(false), responses: { ...failures, 200: sessionResponse } } },
  '/api/auth/refresh': { post: { tags: ['PostgreSQL Auth'], summary: 'Rotate the refresh cookie and access token', description: 'Requires the refresh cookie. Reusing a consumed refresh token revokes that session; serialize client refresh calls.', parameters: [csrf], responses: { ...failures, 200: sessionResponse } } },
  '/api/auth/logout': { post: { tags: ['PostgreSQL Auth'], summary: 'Revoke the current session and clear its cookie', description: 'Supply the refresh cookie or a Bearer access token. Idempotent.', parameters: [csrf], responses: { ...failures, 204: { description: 'Session revoked and cookie cleared' } } } },
  '/api/auth/me': { get: { tags: ['PostgreSQL Auth'], summary: 'Restore the current PostgreSQL identity', security: [{ bearerAuth: [] }], responses: { ...failures, 200: { description: 'Current user; no password or token hashes', content: { 'application/json': { schema: { type: 'object', properties: { user } } } } } } } },
};
