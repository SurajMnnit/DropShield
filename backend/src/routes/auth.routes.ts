import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService } from '../services/auth.service.js';
import { requireAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimiter.js';
import { env } from '../config/env.js';

export const authRouter = Router();

const registerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  email: z.string().email('Invalid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(100)
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
  role: z.enum(['buyer', 'admin']).optional().default('buyer'),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

// Rate limiter for auth attempts: max 20 requests per 15 minutes per IP
const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 20,
  message: 'Too many authentication attempts. Please try again after 15 minutes.',
});

function setAuthCookies(res: Response, token: string, csrfToken: string): void {
  const isProd = env.NODE_ENV === 'production';

  // Secure HTTP-only access token cookie
  res.cookie('access_token', token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'strict' : 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    path: '/',
  });

  // Client-readable CSRF cookie for Double Submit pattern
  res.cookie('XSRF-TOKEN', csrfToken, {
    httpOnly: false,
    secure: isProd,
    sameSite: isProd ? 'strict' : 'lax',
    maxAge: 24 * 60 * 60 * 1000,
    path: '/',
  });
}

/**
 * POST /api/v1/auth/register
 */
authRouter.post('/register', authLimiter, async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid registration input',
        details: parsed.error.format(),
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  try {
    const { user, tokens } = await AuthService.registerUser(parsed.data);
    setAuthCookies(res, tokens.accessToken, tokens.csrfToken);

    res.status(201).json({
      success: true,
      data: {
        user,
        csrfToken: tokens.csrfToken,
        token: tokens.accessToken, // Provided for Authorization Bearer fallback
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'EMAIL_ALREADY_EXISTS') {
      res.status(409).json({
        success: false,
        error: {
          code: 'EMAIL_ALREADY_EXISTS',
          message: 'An account with this email address already exists',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: {
        code: 'REGISTRATION_FAILED',
        message: 'Failed to complete registration',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * POST /api/v1/auth/login
 */
authRouter.post('/login', authLimiter, async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid login input',
        details: parsed.error.format(),
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  try {
    const { user, tokens } = await AuthService.loginUser(parsed.data);
    setAuthCookies(res, tokens.accessToken, tokens.csrfToken);

    res.status(200).json({
      success: true,
      data: {
        user,
        csrfToken: tokens.csrfToken,
        token: tokens.accessToken, // Provided for Authorization Bearer fallback
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'INVALID_CREDENTIALS') {
      res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password combination',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: {
        code: 'LOGIN_FAILED',
        message: 'Authentication failed',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * POST /api/v1/auth/logout
 */
authRouter.post('/logout', requireAuth, (_req: Request, res: Response) => {
  res.clearCookie('access_token', { path: '/' });
  res.clearCookie('XSRF-TOKEN', { path: '/' });

  res.status(200).json({
    success: true,
    data: {
      message: 'Logged out successfully',
    },
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/v1/auth/me
 */
authRouter.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const profile = await AuthService.getUserProfile(req.user!.id);
    if (!profile) {
      res.status(404).json({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User profile no longer exists',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        user: profile,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (_err: unknown) {
    res.status(500).json({
      success: false,
      error: {
        code: 'PROFILE_FETCH_FAILED',
        message: 'Could not fetch user profile',
      },
      timestamp: new Date().toISOString(),
    });
  }
});
