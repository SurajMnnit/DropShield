import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { dbPool } from '../config/database.js';
import { logger } from '../utils/logger.js';

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: 'buyer' | 'admin';
  created_at: Date;
  updated_at: Date;
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: 'buyer' | 'admin';
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  csrfToken: string;
}

export class AuthService {
  /**
   * Hashes a plaintext password using bcrypt with salt rounds of 10.
   */
  static async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 10);
  }

  /**
   * Compares a plaintext password against a stored bcrypt hash.
   */
  static async comparePassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  /**
   * Generates a signed JWT access token and a matching CSRF token.
   */
  static generateAuthTokens(user: { id: string; role: 'buyer' | 'admin'; email: string }): AuthTokens {
    const csrfToken = crypto.randomBytes(32).toString('hex');

    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      csrf: csrfToken,
    };

    const accessToken = jwt.sign(payload, env.JWT_SECRET, {
      expiresIn: '24h',
      algorithm: 'HS256',
    });

    return { accessToken, csrfToken };
  }

  /**
   * Verifies and decodes a JWT access token.
   */
  static verifyAccessToken(token: string): { sub: string; email: string; role: 'buyer' | 'admin'; csrf: string } {
    return jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as {
      sub: string;
      email: string;
      role: 'buyer' | 'admin';
      csrf: string;
    };
  }

  /**
   * Register a new user with bcrypt password hashing and email normalization.
   */
  static async registerUser(params: {
    name: string;
    email: string;
    password: string;
    role?: 'buyer' | 'admin';
  }): Promise<{ user: UserProfile; tokens: AuthTokens }> {
    const normalizedEmail = params.email.trim().toLowerCase();
    const role = params.role || 'buyer';

    // Check if user already exists
    const existing = await dbPool.query('SELECT id FROM users WHERE LOWER(BTRIM(email)) = $1;', [
      normalizedEmail,
    ]);

    if (existing.rows.length > 0) {
      throw new Error('EMAIL_ALREADY_EXISTS');
    }

    const passwordHash = await this.hashPassword(params.password);
    const userId = crypto.randomUUID();

    const insertRes = await dbPool.query<UserRecord>(
      `INSERT INTO users (id, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, role, created_at, updated_at;`,
      [userId, params.name.trim(), normalizedEmail, passwordHash, role]
    );

    const created = insertRes.rows[0];
    const user: UserProfile = {
      id: created.id,
      name: created.name,
      email: created.email,
      role: created.role,
      createdAt: created.created_at.toISOString(),
    };

    const tokens = this.generateAuthTokens(user);
    logger.info(`User registered successfully: ${user.id} [${user.email}]`);
    return { user, tokens };
  }

  /**
   * Authenticate a user by email and password.
   */
  static async loginUser(params: {
    email: string;
    password: string;
  }): Promise<{ user: UserProfile; tokens: AuthTokens }> {
    const normalizedEmail = params.email.trim().toLowerCase();

    const res = await dbPool.query<UserRecord>(
      `SELECT id, name, email, password_hash, role, created_at
       FROM users
       WHERE LOWER(BTRIM(email)) = $1;`,
      [normalizedEmail]
    );

    if (res.rows.length === 0) {
      throw new Error('INVALID_CREDENTIALS');
    }

    const userRecord = res.rows[0];
    const passwordValid = await this.comparePassword(params.password, userRecord.password_hash);
    if (!passwordValid) {
      throw new Error('INVALID_CREDENTIALS');
    }

    const user: UserProfile = {
      id: userRecord.id,
      name: userRecord.name,
      email: userRecord.email,
      role: userRecord.role,
      createdAt: userRecord.created_at.toISOString(),
    };

    const tokens = this.generateAuthTokens(user);
    logger.info(`User logged in successfully: ${user.id} [${user.email}]`);
    return { user, tokens };
  }

  /**
   * Fetch authenticated user profile by ID.
   */
  static async getUserProfile(userId: string): Promise<UserProfile | null> {
    const res = await dbPool.query<UserRecord>(
      `SELECT id, name, email, role, created_at
       FROM users
       WHERE id = $1;`,
      [userId]
    );

    if (res.rows.length === 0) return null;

    const u = res.rows[0];
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      createdAt: u.created_at.toISOString(),
    };
  }
}
