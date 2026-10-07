import { describe, expect, it } from 'vitest';
import {
  cloudinaryDeliverySignature,
  cloudinaryDeliveryUrl,
  cloudinaryPublicId,
  cloudinaryResourceType,
  extensionFor,
} from '../src/adapters/object-storage.js';

describe('Cloudinary addressing', () => {
  it('routes content types to the three Cloudinary resource types', () => {
    expect(cloudinaryResourceType('image/jpeg')).toBe('image');
    expect(cloudinaryResourceType('video/mp4')).toBe('video');
    // PDF is a raw asset: Cloudinary has no pdf resource type and cannot
    // transform one, so it must not be mistaken for an image.
    expect(cloudinaryResourceType('application/pdf')).toBe('raw');
  });

  it('refuses a content type it has no mapping for', () => {
    expect(() => cloudinaryResourceType('application/zip')).toThrow(RangeError);
    expect(() => extensionFor('application/zip')).toThrow(RangeError);
  });

  it('derives the public id from the storage key and the sniffed type', () => {
    const key = 'transactions/tx-1/abc123/0-deadbeef';
    expect(cloudinaryPublicId(key, 'image/jpeg')).toBe(`${key}.jpg`);
    expect(cloudinaryPublicId(key, 'video/quicktime')).toBe(`${key}.mov`);
  });

  it('derives the same public id for the same key and type', () => {
    // Upload and download must agree on the address without sharing state.
    const key = 'transactions/tx-1/abc123/0-deadbeef';
    expect(cloudinaryPublicId(key, 'image/png')).toBe(cloudinaryPublicId(key, 'image/png'));
  });
});

describe('Cloudinary delivery signature', () => {
  it('matches the worked example in Cloudinary own documentation', () => {
    // secret "abcd", transformation "c_fill,w_300,h_250/e_grayscale", public id
    // "sample-authenticated.png" -> first eight characters "iDy_JeBq".
    const toSign = 'c_fill,w_300,h_250/e_grayscale/sample-authenticated.png';
    expect(cloudinaryDeliverySignature(toSign, 'abcd')).toBe('iDy_JeBq');
  });

  it('produces a different signature for a different secret', () => {
    const toSign = 'image/authenticated/sample.jpg';
    expect(cloudinaryDeliverySignature(toSign, 'abcd')).not.toBe(cloudinaryDeliverySignature(toSign, 'dcba'));
  });

  it('produces a different signature for a different path', () => {
    // This is what stops a signed URL for one asset being edited into a URL for
    // another: the path is inside the signed material.
    expect(cloudinaryDeliverySignature('image/authenticated/a.jpg', 'abcd'))
      .not.toBe(cloudinaryDeliverySignature('image/authenticated/b.jpg', 'abcd'));
  });

  it('builds an authenticated delivery URL with the signature before the path', () => {
    expect(cloudinaryDeliveryUrl('demo', 'image', 'sample-authenticated.png', 'abcd')).toBe(
      'https://res.cloudinary.com/demo/image/authenticated/s--QqLhlx8M--/sample-authenticated.png',
    );
  });

  it('signs the public id only, so a nested storage key stays resolvable', () => {
    expect(cloudinaryDeliveryUrl('demo', 'image', 'evidence/tx-1/abc/0-dead.jpg', 'abcd')).toBe(
      'https://res.cloudinary.com/demo/image/authenticated/s--DuSmevu3--/evidence/tx-1/abc/0-dead.jpg',
    );
  });

  it('carries no expiry, which is why the URL is never given to a client', () => {
    // Cloudinary derives the delivery signature only from the path and the API
    // secret. There is no timestamp component, so a signed URL is a permanent
    // capability. This test documents the constraint that the route proxies the
    // bytes rather than redirecting to this URL.
    const url = cloudinaryDeliveryUrl('demo', 'image', 'sample.png', 'abcd');
    expect(url).not.toMatch(/\d{9,}/);
    expect(url).not.toContain('token');
  });
});