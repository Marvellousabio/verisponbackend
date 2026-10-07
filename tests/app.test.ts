import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `pool` is built at module load from DATABASE_URL, so the environment has to be
// controlled before the app module is imported. Without this the assertions
// below silently depend on whether the developer happens to have a DATABASE_URL
// exported in their shell.
async function appWithoutDatabase() {
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', '');
  const { createApp } = await import('../src/app.js');
  return createApp();
}

describe('health endpoint', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('returns an ok status', async () => {
    const app = await appWithoutDatabase();
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('reports readiness as not ready without a configured database', async () => {
    const response = await request(await appWithoutDatabase()).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body.reason).toBe('database_not_configured');
  });

  it('reports a missing database as a configuration fault rather than a 404', async () => {
    // With no DATABASE_URL no API route is mounted. A bare 404 here would read
    // as a wrong path rather than a missing variable.
    const response = await request(await appWithoutDatabase()).get('/api/transactions');

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('NOT_CONFIGURED');
  });
});