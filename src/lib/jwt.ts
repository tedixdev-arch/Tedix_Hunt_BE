import jwt from 'jsonwebtoken';
import { environment } from '../config/environment.js';

export const signJwt = (payload: object, options?: jwt.SignOptions) =>
  jwt.sign(payload, environment.jwtSecret, {
    expiresIn: environment.jwtExpiresIn as jwt.SignOptions['expiresIn'],
    ...(options ?? {}),
  });

export const verifyJwt = <T = any>(token: string): T =>
  jwt.verify(token, environment.jwtSecret) as T;
