import request from 'supertest';
import { createApp } from '../src/app.js';

describe('Health Check API Endpoints', () => {
  const app = createApp();

  it('GET /health returns 200 and healthy status payload', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(typeof res.body.uptime).toBe('number');
    expect(typeof res.body.timestamp).toBe('string');
    expect(res.body.environment).toBeDefined();
    expect(res.body.version).toBe('1.0.0');
    expect(res.body.services).toEqual({
      database: 'up',
      redis: 'up',
      rabbitmq: 'up',
    });
  });

  it('GET /api/health also returns 200 and healthy status', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
  });

  it('GET / root endpoint returns 200 welcome payload', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('DropShield High-Concurrency Booking Engine API');
    expect(res.body.status).toBe('online');
  });

  it('GET /unknown-route returns 404 with error payload', async () => {
    const res = await request(app).get('/unknown-route');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
