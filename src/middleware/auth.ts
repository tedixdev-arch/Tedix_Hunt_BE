import { Request, RequestHandler } from 'express';
import { verifyJwt } from '../lib/jwt.js';
import { User } from '../models/User.js';
import type { IUser } from '../models/User.js';
import type { UserRole } from '../models/UserRole.js';

export interface AuthRequest extends Request {
  user?: IUser;
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

export const requireAnyRole = (requiredRoles: readonly UserRole[]): RequestHandler =>
  (req: AuthRequest, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });

    // Guests are participant identities and cannot exercise privileged capabilities.
    const roles: readonly UserRole[] = req.user.isGuest ? ['participant'] : req.user.roles;
    if (!requiredRoles.some((role) => roles.includes(role))) {
      return res.status(403).json({ error: 'forbidden' });
    }

    next();
  };

export const requireRole = (role: UserRole): RequestHandler => requireAnyRole([role]);
