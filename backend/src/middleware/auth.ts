import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

export interface AuthenticatedUser {
  id: string;
  role: 'buyer' | 'admin';
}

/* eslint-disable @typescript-eslint/no-namespace */
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Authentication Middleware:
 * Resolves user identity from Authorization header or development test headers.
 * NEVER trusts or extracts user identity from request payload bodies.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.header('authorization');

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    // Validate UUID format token or simple subject token for dev/test
    if (UUID_REGEX.test(token)) {
      req.user = {
        id: token,
        role: 'buyer',
      };
      return next();
    }
  }

  // Development / Test explicit header boundary
  if (env.NODE_ENV !== 'production') {
    const testUserId = req.header('x-user-id');
    if (testUserId && UUID_REGEX.test(testUserId)) {
      req.user = {
        id: testUserId,
        role: 'buyer',
      };
      return next();
    }
  }

  // Unauthorized
  res.status(401).json({
    success: false,
    error: {
      code: 'UNAUTHORIZED',
      message: 'Authentication required. Please provide a valid authorization credential.',
    },
    timestamp: new Date().toISOString(),
  });
}
