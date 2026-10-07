import { afterEach, describe, expect, it, vi } from 'vitest';
import { configSchema } from '../src/config.js';

describe('configuration', () => {
  it('accepts an unset inspection window and a plain verified Resend sender', () => {
    const result = configSchema.parse({
      AUTO_RELEASE_HOURS: '',
      RESEND_FROM_EMAIL: 'notifications@verispon.com',
    });

    expect(result.AUTO_RELEASE_HOURS).toBeUndefined();
    expect(result.RESEND_FROM_EMAIL).toBe('notifications@verispon.com');
  });

  it('rejects undersized production session secrets', () => {
    expect(() => configSchema.parse({ NODE_ENV: 'production', SESSION_SECRET: 'short' })).toThrow();
  });

  it('accepts an explicit SameSite override for the session cookie', () => {
    expect(configSchema.parse({ SESSION_SAME_SITE: 'none' }).SESSION_SAME_SITE).toBe('none');
    expect(configSchema.parse({ SESSION_SAME_SITE: 'lax' }).SESSION_SAME_SITE).toBe('lax');
  });

  it('rejects an unknown SameSite value instead of silently defaulting', () => {
    expect(() => configSchema.parse({ SESSION_SAME_SITE: 'strict' })).toThrow();
  });

  it('treats an empty value in a .env file as unset rather than crashing', () => {
    // A template left with `DATABASE_URL=` must take the not-configured path,
    // not fail schema parsing and take the process down at boot.
    const result = configSchema.parse({
      DATABASE_URL: '',
      CLOUDINARY_CLOUD_NAME: '',
      CLOUDINARY_API_KEY: '',
      CLOUDINARY_API_SECRET: '',
      RESEND_API_KEY: '',
      RESEND_FROM_EMAIL: '',
      META_WHATSAPP_TOKEN: '',
      NOMBA_CLIENT_ID: '',
      SESSION_SAME_SITE: '',
      SESSION_SECRET: '',
    });

    expect(result.DATABASE_URL).toBeUndefined();
    expect(result.SESSION_SECRET).toBeUndefined();
    expect(result.SESSION_SAME_SITE).toBeUndefined();
  });

  it('still validates a value that is present', () => {
    expect(() => configSchema.parse({ DATABASE_URL: 'not-a-url' })).toThrow();
    expect(configSchema.parse({ DATABASE_URL: 'postgresql://localhost/verispon' }).DATABASE_URL)
      .toBe('postgresql://localhost/verispon');
  });
});

describe('session cookie SameSite inference', () => {
  async function resolveSameSiteFor(env: Record<string, string>): Promise<'lax' | 'none'> {
    vi.resetModules();
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'a'.repeat(32);
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    delete process.env.SESSION_SAME_SITE;
    const module = await import('../src/config.js');
    return module.SESSION_SAME_SITE;
  }

  afterEach(() => {
    vi.resetModules();
    for (const key of ['NODE_ENV', 'SESSION_SECRET', 'WEB_ORIGIN', 'API_ORIGIN', 'SESSION_SAME_SITE']) {
      delete process.env[key];
    }
  });

  it('uses lax for the local same-site split of ports', async () => {
    await expect(resolveSameSiteFor({ WEB_ORIGIN: 'http://localhost:3000', API_ORIGIN: 'http://localhost:4000' }))
      .resolves.toBe('lax');
  });

  it('keeps lax for an API subdomain of the web origin, which is the same site', async () => {
    // SameSite compares registrable domains, not origins. verispon.com and
    // api.verispon.com are one site, so a Lax cookie is still attached to the
    // cross-origin fetch and the documented production split works as-is.
    await expect(resolveSameSiteFor({ WEB_ORIGIN: 'https://verispon.com', API_ORIGIN: 'https://api.verispon.com' }))
      .resolves.toBe('lax');
  });

  it('uses none when the API is served from a genuinely different site', async () => {
    await expect(resolveSameSiteFor({ WEB_ORIGIN: 'https://verispon.com', API_ORIGIN: 'https://api.verispon.example' }))
      .resolves.toBe('none');
  });

  it('treats a subdomain of the web origin as the same site', async () => {
    await expect(resolveSameSiteFor({ WEB_ORIGIN: 'https://verispon.com', API_ORIGIN: 'https://www.verispon.com' }))
      .resolves.toBe('lax');
  });

  it('lets an explicit setting override the inference', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'a'.repeat(32);
    process.env.WEB_ORIGIN = 'https://verispon.com';
    process.env.API_ORIGIN = 'https://api.verispon.example';
    process.env.SESSION_SAME_SITE = 'lax';
    const module = await import('../src/config.js');
    expect(module.SESSION_SAME_SITE).toBe('lax');
  });
});