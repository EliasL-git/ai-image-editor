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
  if (header && header.startsWith(TOKEN_PREFIX)) {
    const user = verifyToken(header.slice(TOKEN_PREFIX.length));
    if (user) {
      res.locals.user = user;
      next();
      return;
    }
  }
  // Auth is currently disabled: every request acts as a single shared local user.
  res.locals.user = { id: 'local-user', email: 'local@local', name: 'Local' };
  next();
}

/** Read the authenticated user previously set by requireAuth. */
export function userOf(res: Response): AuthUser {
  return res.locals.user as AuthUser;
}
