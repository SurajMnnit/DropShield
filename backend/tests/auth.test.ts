import request from 'supertest';
import { createApp } from '../src/app.js';
import { dbPool } from '../src/config/database.js';

const app = createApp();

describe('Phase 6: Authentication & Authorization Test Suite', () => {
  const testUser = {
    name: 'Ada Lovelace',
    email: `ada.${Date.now()}@example.com`,
    password: 'Password123!',
    role: 'buyer',
  };

  afterAll(async () => {
    // Clean up test user created during test run
    await dbPool.query(`DELETE FROM users WHERE email = $1;`, [testUser.email.toLowerCase()]);
  });

  describe('User Registration', () => {
    it('successfully registers a new user with valid data and sets auth cookies', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send(testUser);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.email).toBe(testUser.email.toLowerCase());
      expect(res.body.data.user.name).toBe(testUser.name);
      expect(res.body.data.user.role).toBe('buyer');
      expect(res.body.data.csrfToken).toBeDefined();

      // Check cookies
      const rawCookies = res.headers['set-cookie'];
      const cookies: string[] = Array.isArray(rawCookies) ? rawCookies : rawCookies ? [rawCookies] : [];
      expect(cookies.length).toBeGreaterThan(0);
      const accessTokenCookie = cookies.find((c: string) => c.startsWith('access_token='));
      const xsrfTokenCookie = cookies.find((c: string) => c.startsWith('XSRF-TOKEN='));
      expect(accessTokenCookie).toBeDefined();
      expect(accessTokenCookie).toContain('HttpOnly');
      expect(xsrfTokenCookie).toBeDefined();
    });

    it('rejects duplicate registration with 409 Conflict', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send(testUser);

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
    });

    it('rejects registration with weak password', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          name: 'Weak User',
          email: 'weak@example.com',
          password: 'weak',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('User Login & Session Management', () => {
    it('authenticates valid credentials and issues JWT and CSRF cookies', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: testUser.email,
          password: testUser.password,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.email).toBe(testUser.email.toLowerCase());
      expect(res.body.data.csrfToken).toBeDefined();
    });

    it('rejects invalid password with 401 Unauthorized', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: testUser.email,
          password: 'WrongPassword123!',
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('rejects non-existent email with 401 Unauthorized', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'nonexistent@example.com',
          password: 'Password123!',
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('GET /api/v1/auth/me & Protected State', () => {
    it('returns profile for authenticated user via Bearer token', async () => {
      // First login
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: testUser.email,
          password: testUser.password,
        });

      const token = loginRes.body.data.token;

      const meRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(meRes.status).toBe(200);
      expect(meRes.body.success).toBe(true);
      expect(meRes.body.data.user.email).toBe(testUser.email.toLowerCase());
    });

    it('rejects request without token with 401', async () => {
      const res = await request(app).get('/api/v1/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('enforces CSRF validation on mutating operations when authenticated via cookies', async () => {
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: testUser.email,
          password: testUser.password,
        });

      const rawCookies = loginRes.headers['set-cookie'];
      const cookies: string[] = Array.isArray(rawCookies) ? rawCookies : rawCookies ? [rawCookies] : [];
      const accessTokenCookie = cookies.find((c: string) => c.startsWith('access_token='))!.split(';')[0];
      const validCsrf = loginRes.body.data.csrfToken;

      // Mutating call without X-CSRF-Token should be rejected 403
      const failRes = await request(app)
        .post('/api/v1/auth/logout')
        .set('Cookie', [accessTokenCookie]);

      expect(failRes.status).toBe(403);
      expect(failRes.body.error.code).toBe('CSRF_VALIDATION_FAILED');

      // Mutating call with valid X-CSRF-Token should succeed
      const passRes = await request(app)
        .post('/api/v1/auth/logout')
        .set('Cookie', [accessTokenCookie])
        .set('X-CSRF-Token', validCsrf);

      expect(passRes.status).toBe(200);
      expect(passRes.body.success).toBe(true);
    });
  });
});
