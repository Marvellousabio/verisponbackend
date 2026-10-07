import { createHash, randomUUID } from 'node:crypto';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { fileTypeFromBuffer } from 'file-type';
import type { Express } from 'express';
import type { Pool } from 'pg';
import type { ObjectStorage } from '../adapters/object-storage.js';
import type { IdempotencyContext } from '../db/idempotency.js';
import { EvidenceAccessError, PostgresEvidenceRepository } from '../repositories/evidence-repository.js';

const TYPE_TO_MIME = {
  ITEM_BEFORE_TRANSACTION: new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  ITEM_PACKAGING: new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm']),
  ITEM_HANDOVER: new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm']),
  ITEM_SHIPMENT: new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm']),
  DELIVERY: new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm']),
  ITEM_RECEIVED: new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm']),
  ITEM_DAMAGED: new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm']),
  RECEIPT: new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  DOCUMENT: new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  OTHER: new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'video/mp4', 'video/quicktime', 'video/webm']),
} as const;

const IMAGE_LIMIT = 5 * 1024 * 1024;
const PDF_LIMIT = 10 * 1024 * 1024;
const VIDEO_LIMIT = 25 * 1024 * 1024;
const TOTAL_LIMIT = 50 * 1024 * 1024;

export class EvidenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceValidationError';
  }
}

interface PreparedEvidence {
  id: string;
  key: string;
  bytes: Buffer;
  contentType: string;
  checksum: string;
  description: string | null;
}

export class EvidenceService {
  private readonly repository: PostgresEvidenceRepository;

  constructor(pool: Pool, private readonly storage: ObjectStorage) {
    this.repository = new PostgresEvidenceRepository(pool);
  }

  async upload(
    transactionId: string,
    uploaderId: string,
    type: keyof typeof TYPE_TO_MIME,
    description: string | undefined,
    files: Express.Multer.File[],
    idempotency: IdempotencyContext,
  ): Promise<{ evidence: Array<{ id: string; url: string }> }> {
    if (files.length < 1 || files.length > 5) throw new EvidenceValidationError('Submit between 1 and 5 files');
    if (description && description.length > 1000) throw new EvidenceValidationError('Description must be at most 1000 characters');
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    if (totalBytes > TOTAL_LIMIT) throw new EvidenceValidationError('Evidence submission exceeds 50 MB total');

    const idemHash = createHash('sha256').update(idempotency.key).digest('hex');
    const prepared: PreparedEvidence[] = [];
    let imageCount = 0;
    for (const [index, file] of files.entries()) {
      const sniffed = await fileTypeFromBuffer(file.buffer);
      const contentType = sniffed?.mime;
      if (!contentType || !TYPE_TO_MIME[type].has(contentType)) {
        throw new EvidenceValidationError('File content does not match an allowed evidence type');
      }
      const limit = contentType.startsWith('image/') ? IMAGE_LIMIT : contentType === 'application/pdf' ? PDF_LIMIT : VIDEO_LIMIT;
      if (file.size > limit) throw new EvidenceValidationError(`File exceeds the ${limit / 1024 / 1024} MB limit for its type`);
      if (contentType.startsWith('image/')) imageCount += 1;
      const checksum = createHash('sha256').update(file.buffer).digest('hex');
      const id = randomUUID();
      prepared.push({
        id,
        key: `transactions/${transactionId}/${idemHash}/${index}-${checksum}`,
        bytes: file.buffer,
        contentType,
        checksum,
        description: description?.trim() || null,
      });
    }
    if (imageCount > 5) throw new EvidenceValidationError('A submission may contain at most 5 images');

    idempotency.requestHash = createHash('sha256')
      .update(`${idempotency.requestHash}:${type}:${description ?? ''}:${prepared.map((item) => item.checksum).join(':')}`)
      .digest('hex');

    const uploaded: Array<{ key: string; contentType: string }> = [];
    try {
      for (const item of prepared) {
        await this.storage.put(item.key, item.bytes, item.contentType);
        uploaded.push({ key: item.key, contentType: item.contentType });
      }
      return await this.repository.createBatch(transactionId, uploaderId, prepared.map((item) => ({
        id: item.id,
        type,
        stage: '',
        uploader_name: '',
        storage_key: item.key,
        content_type: item.contentType,
        bytes: item.bytes.length,
        checksum: item.checksum,
        description: item.description,
        created_at: new Date().toISOString(),
      })), idempotency);
    } catch (error) {
      await Promise.allSettled(uploaded.map((item) => this.storage.remove(item.key, item.contentType)));
      throw error;
    }
  }

  async list(transactionId: string, accountId: string): Promise<{ evidence: Array<Record<string, unknown>>; expected_stage: string } | null> {
    const result = await this.repository.listForParty(transactionId, accountId);
    if (!result) return null;
    return {
      // `storage_key` is the Cloudinary internal path. It is not on the wire:
      // a client downloads through /api/evidence/:transactionId/:file, which
      // re-checks party membership on every read.
      evidence: result.evidence.map(({ storage_key: _storageKey, ...item }) => ({
        ...item,
        url: `/api/evidence/${transactionId}/${item.id}`,
      })),
      expected_stage: result.expected_stage,
    };
  }

  async remove(transactionId: string, evidenceId: string, accountId: string): Promise<void> {
    const removed = await this.repository.deleteForParty(transactionId, evidenceId, accountId);
    if (!removed) return;
    await this.storage.remove(removed.storage_key, removed.content_type);
  }

  async download(transactionId: string, evidenceId: string, accountId: string): Promise<{ body: NodeReadableStream<Uint8Array>; contentType: string } | null> {    const item = await this.repository.findForParty(transactionId, evidenceId, accountId);
    if (!item) return null;
    return { body: await this.storage.get(item.storage_key, item.content_type), contentType: item.content_type };
  }
}

export { EvidenceAccessError };