process.env.NODE_ENV = 'test';
if (!process.env.TEST_DATABASE_URL) {
  process.env.TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/dropshield_test';
}
