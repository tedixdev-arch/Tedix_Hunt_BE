import { Request, RequestHandler } from 'express';
import { verifyJwt } from '../lib/jwt.js';
import { User } from '../models/User.js';

export interface AuthRequest extends Request {
  user?: any;
}

export const requireAuth: RequestHandler = async (req: AuthRequest, res, next) => {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const token = header.slice(7);

  try {
    const payload = verifyJwt<{ sub?: unknown; type?: unknown }>(token);
    // Explicit token type prevents any signed non-access credential being used as a bearer token.
    if (payload.type !== 'access' || typeof payload.sub !== 'string' || !payload.sub) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const user = await User.findById(payload.sub);

    if (!user) return res.status(401).json({ error: 'unauthorized' });

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'unauthorized' });
  }
};
