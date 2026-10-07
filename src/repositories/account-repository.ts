import { randomInt, randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';

export type AccountRole = 'BUYER' | 'SELLER' | 'ADMIN';

export interface Account {
  id: string;
  reference: string;
  name: string;
  email: string;
  phone: string | null;
  passcodeHash: string;
  roles: AccountRole[];
  capabilities: string[];
  emailVerifiedAt: Date | null;
  phoneVerifiedAt: Date | null;
  frozenAt: Date | null;
  whatsappConsentAt: Date | null;
  whatsappOptedOutAt: Date | null;
}

interface AccountRow extends QueryResultRow {
  id: string;
  reference: string;
  name: string;
  email: string;
  phone: string | null;
  passcode_hash: string;
  roles: AccountRole[];
  capabilities: string[];
  email_verified_at: Date | null;
  phone_verified_at: Date | null;
  frozen_at: Date | null;
  whatsapp_consent_at: Date | null;
  whatsapp_opted_out_at: Date | null;
}

function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;

  const normalized = input.trim().replace(/\s+/g, '').replace(/^\+/, '');
  const digits = normalized.replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    reference: row.reference,
    name: row.name,
    email: row.email,
    phone: row.phone,
    passcodeHash: row.passcode_hash,
    roles: row.roles,
    capabilities: row.capabilities,
    emailVerifiedAt: row.email_verified_at,
    phoneVerifiedAt: row.phone_verified_at,
    frozenAt: row.frozen_at,
    whatsappConsentAt: row.whatsapp_consent_at,
    whatsappOptedOutAt: row.whatsapp_opted_out_at,
  };
}

export class PostgresAccountRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: { name: string; email: string; phone: string | null; passcodeHash: string; roles: AccountRole[] }): Promise<Account> {
    const reference = `VSP-${randomInt(100_000, 1_000_000)}`;
    const phone = normalizePhone(input.phone);
    const result = await this.pool.query<AccountRow>(
      `insert into accounts (id, reference, name, email, phone, passcode_hash, roles)
       values ($1, $2, $3, $4, $5, $6, $7::account_role[])
       returning id, reference, name, email::text, phone, passcode_hash, roles,
                 coalesce(array(select capability::text from account_admin_capabilities where account_id = accounts.id), '{}') as capabilities,
                 email_verified_at, phone_verified_at, frozen_at, whatsapp_consent_at, whatsapp_opted_out_at`,
      [randomUUID(), reference, input.name, input.email.toLowerCase(), phone, input.passcodeHash, input.roles],
    );
    return mapAccount(result.rows[0]!);
  }

  async findByIdentifier(identifier: string): Promise<Account | null> {
    const trimmed = identifier.trim();
    const normalized = trimmed.toLowerCase();
    const phone = normalizePhone(trimmed);
    const result = await this.pool.query<AccountRow>(
                  `select id, reference, name, email::text, phone, passcode_hash, roles,
              coalesce(array(select capability::text from account_admin_capabilities where account_id = accounts.id), '{}') as capabilities,
                    email_verified_at, phone_verified_at, frozen_at, whatsapp_consent_at, whatsapp_opted_out_at
       from accounts where deleted_at is null and (email = $1 or phone = $2 or phone = $3) limit 1`,
      [normalized, phone, trimmed.replace(/^\+/, '')],
    );
    return result.rows[0] ? mapAccount(result.rows[0]) : null;
  }

  async findById(id: string): Promise<Account | null> {
    const result = await this.pool.query<AccountRow>(
                  `select id, reference, name, email::text, phone, passcode_hash, roles,
              coalesce(array(select capability::text from account_admin_capabilities where account_id = accounts.id), '{}') as capabilities,
                    email_verified_at, phone_verified_at, frozen_at, whatsapp_consent_at, whatsapp_opted_out_at
       from accounts where id = $1 and deleted_at is null`,
      [id],
    );
    return result.rows[0] ? mapAccount(result.rows[0]) : null;
  }

  async updatePasscode(id: string, passcodeHash: string): Promise<void> {
    await this.pool.query('update accounts set passcode_hash = $2, updated_at = now() where id = $1', [id, passcodeHash]);
  }

  async findVerifiedByPhone(phone: string): Promise<Account | null> {
    const normalized = normalizePhone(phone);
    const result = await this.pool.query<AccountRow>(
      `select id, reference, name, email::text, phone, passcode_hash, roles,
              coalesce(array(select capability::text from account_admin_capabilities where account_id = accounts.id), '{}') as capabilities,
              email_verified_at, phone_verified_at, frozen_at, whatsapp_consent_at, whatsapp_opted_out_at
       from accounts where phone = $1 and phone_verified_at is not null and deleted_at is null limit 1`,
      [normalized],
    );
    return result.rows[0] ? mapAccount(result.rows[0]) : null;
  }

  async setWhatsAppPreference(id: string, optedIn: boolean): Promise<void> {
    if (optedIn) {
      await this.pool.query(
        `update accounts set whatsapp_consent_at = now(), whatsapp_opted_out_at = null, updated_at = now()
         where id = $1 and phone is not null and phone_verified_at is not null`, [id],
      );
    } else {
      await this.pool.query(
        `update accounts set whatsapp_opted_out_at = now(), whatsapp_consent_at = null, updated_at = now()
         where id = $1`, [id],
      );
    }
  }

  async recordWhatsAppInbound(id: string, receivedAt: Date): Promise<void> {
    await this.pool.query(
      `update accounts
       set last_whatsapp_inbound_at = greatest(
         coalesce(last_whatsapp_inbound_at, $2::timestamptz), $2::timestamptz
       )
       where id = $1 and deleted_at is null`,
      [id, receivedAt.toISOString()],
    );
  }
}