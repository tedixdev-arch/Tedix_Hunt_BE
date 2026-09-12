import { Router, type Request, type Response, type RequestHandler, type ErrorRequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { AuthError, currentUser, login, logout, refresh, register, validToken } from '../services/auth.js';

const cookieName = () => process.env.NODE_ENV === 'production' ? '__Host-tedixhunt_refresh' : 'tedixhunt_refresh';
const cookieOptions = () => ({ httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' as const, path: '/' });
const refreshCookie = (request: Request) => {
  const matches = (request.headers.cookie ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName()}=`));
  const token = matches.length === 1 ? matches[0].slice(cookieName().length + 1) : undefined;
  return validToken(token) ? token : undefined;
};
const bearer = (request: Request) => {
  const value = request.headers.authorization;
  const token = value?.startsWith('Bearer ') ? value.slice(7) : undefined;
  return validToken(token) ? token : undefined;
};
const invalid = () => new AuthError(400, 'invalid_input', 'Check the supplied account details.');

function credentials(request: Request, registration: boolean) {
  const body = request.body;
  const allowed = registration ? ['email', 'password', 'displayName'] : ['email', 'password'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) throw invalid();
  if (typeof body.email !== 'string' || typeof body.password !== 'string') throw invalid();
  const email = body.email.trim().toLowerCase();
  const password = body.password;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email) || password.length < 1 || password.length > 128 || Buffer.byteLength(password, 'utf8') > 512) throw invalid();
  if (registration && [...password].length < 15) throw invalid();
  const name = body.displayName;
  if (name != null && (typeof name !== 'string' || !name.trim() || [...name.trim()].length > 120)) throw invalid();
  return { email, password, displayName: typeof name === 'string' ? name.trim() : null };
}

function sendSession(response: Response, session: Awaited<ReturnType<typeof login>>, status = 200) {
  response.cookie(cookieName(), session.refreshToken, { ...cookieOptions(), expires: session.refreshExpiresAt });
  response.status(status).json({ user: session.user, accessToken: session.accessToken, tokenType: 'Bearer', expiresIn: session.expiresIn });
}

export const createAuthRouter = () => {
  const router = Router();
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
  const csrf: RequestHandler = (request, _response, next) => {
    if (request.method !== 'POST') return next();
    // A custom header blocks cross-site form submission; browser fetch requires CORS preflight.
    const origin = request.get('Origin');
    const allowedOrigin = process.env.WEB_ORIGIN || `${request.protocol}://${request.get('host')}`;
    if (request.get('X-TedixHunt-CSRF') !== '1' || (origin && origin !== allowedOrigin)) {
      return next(new AuthError(403, 'forbidden', 'Request origin could not be verified.'));
    }
    next();
  };
  router.use(csrf);
  const accountLimit = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'rate_limited', message: 'Too many attempts. Try again later.' },
  });
  const sessionLimit = rateLimit({
    windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'rate_limited', message: 'Too many requests. Try again later.' },
  });
  router.post('/register', accountLimit, async (request, response) => {
    const input = credentials(request, true);
    sendSession(response, await register(input.email, input.password, input.displayName), 201);
  });
  router.post('/login', accountLimit, async (request, response) => {
    const input = credentials(request, false);
    sendSession(response, await login(input.email, input.password));
  });
  router.post('/refresh', sessionLimit, async (request, response) => {
    const token = refreshCookie(request);
    if (!token) throw new AuthError(401, 'unauthorized', 'Authentication is required.');
    sendSession(response, await refresh(token));
  });
  router.post('/logout', sessionLimit, async (request, response) => {
    await logout(refreshCookie(request), bearer(request));
    response.clearCookie(cookieName(), cookieOptions());
    response.status(204).end();
  });
  router.get('/me', sessionLimit, async (request, response) => {
    const token = bearer(request);
    if (!token) throw new AuthError(401, 'unauthorized', 'Authentication is required.');
    response.json({ user: await currentUser(token) });
  });
  const errors: ErrorRequestHandler = (error, request, response, _next) => {
    if (error instanceof AuthError) {
      if (request.path === '/refresh' && error.status === 401) response.clearCookie(cookieName(), cookieOptions());
      response.status(error.status).json({ error: error.code, message: error.message });
      return;
    }
    // Never expose database exceptions, hashes, or tokens, even in development.
    console.error('Authentication operation failed.');
    response.status(503).json({ error: 'service_unavailable', message: 'Authentication is temporarily unavailable.' });
  };
  router.use(errors);
  return router;
};
