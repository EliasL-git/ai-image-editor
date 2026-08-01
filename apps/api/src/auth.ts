import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config.js';

const TOKEN_PREFIX = 'Bearer ';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export function signToken(user: AuthUser): string {
  return jwt.sign({ sub: user.id, email: user.email, name: user.name }, config.jwtSecret, {
    expiresIn: config.tokenTtl as jwt.SignOptions['expiresIn'],
  });
}

export function verifyToken(token: string): AuthUser | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    if (!payload.sub) return null;
    return { id: payload.sub, email: payload.email ?? '', name: payload.name ?? '' };
  } catch {
    return null;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith(TOKEN_PREFIX)) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }
  const user = verifyToken(header.slice(TOKEN_PREFIX.length));
  if (!user) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  res.locals.user = user;
  next();
}

export function currentUser(req: Request): AuthUser {
  return resLocalsUser(req) as AuthUser;
}

function resLocalsUser(req: Request): AuthUser | undefined {
  // express 4 stores locals on res; this helper keeps call sites clean
  const res = (req as unknown as { res?: Response }).res;
  return res?.locals?.user as AuthUser | undefined;
}
