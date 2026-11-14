import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { AuthService } from '../services/auth.service.js';

export interface AuthenticatedUser {
  id: string;
  role: 'buyer' | 'admin';
  email?: string;
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
 * Resolves user identity from secure HTTP-only cookies or Authorization Bearer header.
 * Enforces CSRF token check for state-mutating requests when authenticating via cookies.
 * NEVER trusts or extracts user identity from request payload bodies.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  let token: string | undefined;
  let isCookieAuth = false;

  // 1. Check HTTP-only cookie first
  if (req.cookies && req.cookies.access_token) {
    token = req.cookies.access_token;
    isCookieAuth = true;
  }

  // 2. Fall back to Authorization Bearer header
  if (!token) {
    const authHeader = req.header('authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    }
  }

  // 3. Verify JWT token if present
  if (token) {
    try {
      const decoded = AuthService.verifyAccessToken(token);

      // CSRF protection for cookie-authenticated mutating operations (POST, PUT, DELETE, PATCH)
      if (isCookieAuth && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
        const clientCsrf = req.header('x-csrf-token');
        if (!clientCsrf || clientCsrf !== decoded.csrf) {
          res.status(403).json({
            success: false,
            error: {
              code: 'CSRF_VALIDATION_FAILED',
              message: 'Invalid or missing CSRF token',
            },
            timestamp: new Date().toISOString(),
          });
          return;
        }
      }

      req.user = {
        id: decoded.sub,
        role: decoded.role,
        email: decoded.email,
      };
      return next();
    } catch {
      // Token invalid or expired
      res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_TOKEN',
          message: 'Session token has expired or is invalid. Please log in again.',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }
  }

  // 4. Test boundary: only allowed when strictly in test environment for mock test clients
  if (env.NODE_ENV === 'test') {
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

/**
 * Role-Based Access Control (RBAC) guard.
 */
export function requireRole(role: 'admin' | 'buyer') {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required.',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (req.user.role !== role) {
      res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: `Access denied. '${role.toUpperCase()}' role required.`,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    next();
  };
}
