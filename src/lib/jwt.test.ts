import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signJwt, verifyJwt } from './jwt.js';
import { environment } from '../config/environment.js';

describe('configured JWT signing and verification', () => {
  it('retains HS256, access claims and the existing default expiry', () => {
    const token = signJwt({ sub: 'disposable-user', type: 'access' });
    const claims = verifyJwt<jwt.JwtPayload>(token);
    expect(claims).toMatchObject({ sub: 'disposable-user', type: 'access' });
    expect(claims.exp! - claims.iat!).toBe(15 * 60);
    expect(jwt.decode(token, { complete: true })?.header.alg).toBe('HS256');
    expect(jwt.verify(token, environment.jwtSecret)).toEqual(claims);
  });

  it('preserves the guest expiry override', () => {
    const claims = verifyJwt<jwt.JwtPayload>(signJwt({ sub: 'guest' }, { expiresIn: '1h' }));
    expect(claims.exp! - claims.iat!).toBe(3600);
  });

  it('rejects tokens signed with another key', () => {
    const token = jwt.sign({ sub: 'disposable-user', type: 'access' }, randomBytes(32).toString('hex'));
    expect(() => verifyJwt(token)).toThrow('invalid signature');
  });

  it('rejects the historical signing key', () => {
    expect(() => verifyJwt(jwt.sign({ sub: 'disposable-user' }, 'change-me'))).toThrow('invalid signature');
  });
});
