import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { User } from '../db/models/User';
import { Types } from 'mongoose';

const SALT_ROUNDS = 12;

export interface AuthPayload {
  userId: string;
  email: string;
}

export interface AuthedRequest extends Request {
  user?: AuthPayload;
}

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET env var is not set');
  return secret;
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, jwtSecret(), { expiresIn: '30d' });
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, jwtSecret()) as AuthPayload;
}

export function toObjectId(id: string): Types.ObjectId {
  return new Types.ObjectId(id);
}

export async function registerUser(
  email: string,
  password: string,
  name?: string
): Promise<{ token: string; user: { id: string; email: string; name?: string } }> {
  if (!email || !password) throw Object.assign(new Error('Email and password required'), { status: 400 });
  if (password.length < 8) throw Object.assign(new Error('Password must be at least 8 characters'), { status: 400 });

  const existing = await User.findOne({ email: email.toLowerCase().trim() });
  if (existing) throw Object.assign(new Error('Email already registered'), { status: 409 });

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await User.create({ email, passwordHash, name });

  const payload: AuthPayload = { userId: String(user._id), email: user.email };
  return {
    token: signToken(payload),
    user: { id: String(user._id), email: user.email, name: user.name },
  };
}

export async function loginUser(
  email: string,
  password: string
): Promise<{ token: string; user: { id: string; email: string; name?: string } }> {
  if (!email || !password) throw Object.assign(new Error('Email and password required'), { status: 400 });

  const user = await User.findOne({ email: email.toLowerCase().trim() });
  if (!user) throw Object.assign(new Error('Invalid credentials'), { status: 401 });

  const ok = await user.comparePassword(password);
  if (!ok) throw Object.assign(new Error('Invalid credentials'), { status: 401 });

  const payload: AuthPayload = { userId: String(user._id), email: user.email };
  return {
    token: signToken(payload),
    user: { id: String(user._id), email: user.email, name: user.name },
  };
}

/**
 * Middleware: require a valid JWT Bearer token.
 */
export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }
  try {
    req.user = verifyToken(header.slice(7));
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Middleware: attach user if token present; otherwise proceed unauthenticated.
 */
export function optionalAuth(
  req: AuthedRequest,
  _res: Response,
  next: NextFunction
): void {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      req.user = verifyToken(header.slice(7));
    } catch {
      // Invalid token → treat as anonymous
    }
  }
  next();
}
