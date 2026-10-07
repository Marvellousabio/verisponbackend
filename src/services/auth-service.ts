import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { hashPasscode, passcodeNeedsRehash, verifyPasscode } from '../auth/password.js';
import type { Account, AccountRole } from '../repositories/account-repository.js';
import { PostgresAccountRepository } from '../repositories/account-repository.js';
import { encryptSecret } from '../auth/secret-payload.js';

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid credentials');
    this.name = 'InvalidCredentialsError';
  }
}

export class RateLimitError extends Error {
  constructor() {
    super('Too many attempts. Please try again later.');
    this.name = 'RateLimitError';
  }
}

export class AuthService {
  private readonly accounts: PostgresAccountRepository;
  private dummyHash: Promise<string> | null = null;

  constructor(private readonly pool: Pool, private readonly secret: string) {
    this.accounts = new PostgresAccountRepository(pool);
  }

  async register(input: { name: string; email: string; phone?: string | undefined; passcode: string; roles?: AccountRole[] | undefined }): Promise<Account> {
    const roles: AccountRole[] = [...new Set<AccountRole>(input.roles ?? ['BUYER'])];
    if (roles.length === 0 || roles.some((role) => role === 'ADMIN')) throw new RangeError('Only BUYER and SELLER roles can be self-assigned');
    const passcodeHash = await hashPasscode(input.passcode);
    return this.accounts.create({
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      phone: input.phone ? input.phone.replace(/\D/g, '') : null,
      passcodeHash,
      roles,
    });
  }

  async login(identifier: string, passcode: string, sourceAddress: string): Promise<Account> {
    await this.assertNotLimited('login.identifier', identifier.toLowerCase(), 900_000, 5);
    await this.assertNotLimited('login.address', sourceAddress, 900_000, 60);

    const account = await this.accounts.findByIdentifier(identifier);
    this.dummyHash ??= hashPasscode('000000');
    const valid = await verifyPasscode(passcode, account?.passcodeHash ?? await this.dummyHash);
    if (!account || !valid || account.frozenAt) {
      await Promise.all([
        this.recordFailure('login.identifier', identifier.toLowerCase(), 900_000),
        this.recordFailure('login.address', sourceAddress, 900_000),
      ]);
      throw new InvalidCredentialsError();
    }

    if (passcodeNeedsRehash(account.passcodeHash)) {
      await this.accounts.updatePasscode(account.id, await hashPasscode(passcode));
    }
    await this.clearLimit('login.identifier', identifier.toLowerCase());
    return account;
  }

  async requestRecovery(identifier: string, sourceAddress: string): Promise<void> {
    await this.enforceLimit('recovery.send.identifier', identifier.toLowerCase(), 3_600_000, 3);
    await this.enforceLimit('recovery.send.address', sourceAddress, 3_600_000, 10);
    const account = await this.accounts.findByIdentifier(identifier);
    if (!account?.phone) return;

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const codeHash = createHmac('sha256', this.secret).update(`${account.id}:${code}`).digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('update recovery_challenges set consumed_at = now() where account_id = $1 and consumed_at is null', [account.id]);
      await client.query(
        'insert into recovery_challenges (account_id, code_hash, expires_at) values ($1, $2, now() + interval \'10 minutes\')',
        [account.id, codeHash],
      );
      await client.query(
        `insert into outbox_events (topic, payload)
         values ('whatsapp.recovery_code', $1)`,
        [JSON.stringify({ account_id: account.id, encrypted_code: encryptSecret(code, this.secret) })],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async verifyRecovery(identifier: string, code: string, newPasscode: string): Promise<Account> {
    const account = await this.accounts.findByIdentifier(identifier);
    if (!account) throw new InvalidCredentialsError();
    await this.enforceLimit('recovery.verify', account.id, 600_000, 5);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await client.query<{ id: string; code_hash: string; attempts: number }>(
        `select id, code_hash, attempts from recovery_challenges
         where account_id = $1 and consumed_at is null and expires_at > now()
         order by created_at desc limit 1 for update`,
        [account.id],
      );
      const challenge = result.rows[0];
      const supplied = createHmac('sha256', this.secret).update(`${account.id}:${code}`).digest();
      const expected = challenge ? Buffer.from(challenge.code_hash, 'hex') : Buffer.alloc(supplied.length);
      const valid = Boolean(challenge && challenge.attempts < 5 && supplied.length === expected.length && timingSafeEqual(supplied, expected));
      if (!valid) {
        if (challenge) await client.query('update recovery_challenges set attempts = attempts + 1 where id = $1', [challenge.id]);
        await client.query('commit');
        throw new InvalidCredentialsError();
      }
      const passcodeHash = await hashPasscode(newPasscode);
      await client.query('update accounts set passcode_hash = $2, updated_at = now() where id = $1', [account.id, passcodeHash]);
      await client.query('update recovery_challenges set consumed_at = now() where id = $1', [challenge!.id]);
      await client.query('commit');
      return { ...account, passcodeHash };
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async accountById(id: string): Promise<Account | null> {
    return this.accounts.findById(id);
  }

  async accountByPhone(phone: string): Promise<Account | null> {
    return this.accounts.findVerifiedByPhone(phone);
  }

  async setWhatsAppPreference(accountId: string, optedIn: boolean): Promise<void> {
    return this.accounts.setWhatsAppPreference(accountId, optedIn);
  }

  async recordWhatsAppInbound(accountId: string, receivedAt: Date): Promise<void> {
    return this.accounts.recordWhatsAppInbound(accountId, receivedAt);
  }

  async enforceWhatsAppRateLimit(sender: string): Promise<void> {
    await this.enforceLimit('whatsapp.inbound', sender, 15 * 60_000, 20);
  }

  async requestVerification(accountId: string, channel: 'EMAIL' | 'PHONE'): Promise<void> {
    const account = await this.accounts.findById(accountId);
    if (!account) throw new InvalidCredentialsError();
    if (channel === 'PHONE' && !account.phone) throw new RangeError('Add a phone number before verifying it');
    if (channel === 'EMAIL' && account.emailVerifiedAt) return;
    if (channel === 'PHONE' && account.phoneVerifiedAt) return;
    await this.enforceLimit(`verification.${channel.toLowerCase()}`, accountId, 3_600_000, 3);
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const codeHash = createHmac('sha256', this.secret).update(`${account.id}:${channel}:${code}`).digest('hex');
    const encryptedCode = encryptSecret(code, this.secret);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `update account_verification_challenges set consumed_at = now()
         where account_id = $1 and channel = $2 and verified_at is null and consumed_at is null`, [accountId, channel],
      );
      await client.query(
        `insert into account_verification_challenges (account_id, channel, code_hash, expires_at)
         values ($1, $2, $3, now() + interval '10 minutes')`, [accountId, channel, codeHash],
      );
      await client.query(
        `insert into outbox_events (topic, payload) values ('account.verification_code', $1)`,
        [JSON.stringify({ account_id: accountId, channel, encrypted_code: encryptedCode })],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }

  async verifyChannel(accountId: string, channel: 'EMAIL' | 'PHONE', code: string): Promise<void> {
    await this.enforceLimit(`verification.${channel.toLowerCase()}.attempt`, accountId, 600_000, 5);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await client.query<{ id: string; code_hash: string; attempts: number }>(
        `select id, code_hash, attempts from account_verification_challenges
         where account_id = $1 and channel = $2 and verified_at is null and consumed_at is null and expires_at > now()
         order by created_at desc limit 1 for update`, [accountId, channel],
      );
      const challenge = result.rows[0];
      const supplied = createHmac('sha256', this.secret).update(`${accountId}:${channel}:${code}`).digest();
      const expected = challenge ? Buffer.from(challenge.code_hash, 'hex') : Buffer.alloc(supplied.length);
      const valid = Boolean(challenge && challenge.attempts < 5 && supplied.length === expected.length && timingSafeEqual(supplied, expected));
      if (!valid) {
        if (challenge) await client.query('update account_verification_challenges set attempts = attempts + 1 where id = $1', [challenge.id]);
        await client.query('commit');
        throw new InvalidCredentialsError();
      }
      await client.query('update account_verification_challenges set verified_at = now(), consumed_at = now() where id = $1', [challenge!.id]);
      const field = channel === 'EMAIL' ? 'email_verified_at' : 'phone_verified_at';
      await client.query(`update accounts set ${field} = now(), updated_at = now() where id = $1`, [accountId]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  private async enforceLimit(scope: string, subject: string, windowMs: number, limit: number): Promise<void> {
    const subjectHash = createHash('sha256').update(subject).digest('hex');
    const result = await this.pool.query<{ attempts: number }>(
      `insert into rate_limit_buckets (scope, subject_hash, window_started_at, attempts)
       values ($1, $2, now(), 1)
       on conflict (scope, subject_hash) do update
       set attempts = case when rate_limit_buckets.window_started_at <= now() - ($3 * interval '1 millisecond') then 1 else rate_limit_buckets.attempts + 1 end,
           window_started_at = case when rate_limit_buckets.window_started_at <= now() - ($3 * interval '1 millisecond') then now() else rate_limit_buckets.window_started_at end
       returning attempts`,
      [scope, subjectHash, windowMs],
    );
    if (result.rows[0]!.attempts > limit) throw new RateLimitError();
  }

  private async assertNotLimited(scope: string, subject: string, windowMs: number, limit: number): Promise<void> {
    const subjectHash = createHash('sha256').update(subject).digest('hex');
    const result = await this.pool.query<{ attempts: number }>(
      `select attempts from rate_limit_buckets
       where scope = $1 and subject_hash = $2
         and window_started_at > now() - ($3 * interval '1 millisecond')`,
      [scope, subjectHash, windowMs],
    );
    if ((result.rows[0]?.attempts ?? 0) >= limit) throw new RateLimitError();
  }

  private async recordFailure(scope: string, subject: string, windowMs: number): Promise<void> {
    const subjectHash = createHash('sha256').update(subject).digest('hex');
    await this.pool.query(
      `insert into rate_limit_buckets (scope, subject_hash, window_started_at, attempts)
       values ($1, $2, now(), 1)
       on conflict (scope, subject_hash) do update
       set attempts = case when rate_limit_buckets.window_started_at <= now() - ($3 * interval '1 millisecond') then 1 else rate_limit_buckets.attempts + 1 end,
           window_started_at = case when rate_limit_buckets.window_started_at <= now() - ($3 * interval '1 millisecond') then now() else rate_limit_buckets.window_started_at end`,
      [scope, subjectHash, windowMs],
    );
  }

  private async clearLimit(scope: string, subject: string): Promise<void> {
    const subjectHash = createHash('sha256').update(subject).digest('hex');
    await this.pool.query('delete from rate_limit_buckets where scope = $1 and subject_hash = $2', [scope, subjectHash]);
  }
}