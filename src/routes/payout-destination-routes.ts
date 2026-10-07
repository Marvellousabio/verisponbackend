import { Router } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import { encryptSecret, decryptSecret } from '../auth/secret-payload.js';
import { APPLICATION_SECRET } from '../config.js';
import { NombaAdapter } from '../adapters/nomba.js';
import { requireAuth } from '../middleware/auth.js';
import { requireSameOrigin } from '../middleware/same-origin.js';
import type { AuthService } from '../services/auth-service.js';

const destinationSchema = z.object({
  bank_code: z.string().trim().min(2).max(10),
  bank_name: z.string().trim().min(1).max(100),
  account_number: z.string().regex(/^\d{10}$/),
});

export function createPayoutDestinationRouter(pool: Pool, auth: AuthService) {
  const router = Router();
  const nomba = new NombaAdapter();
  router.use(requireAuth(auth));

  router.get('/', async (request, response, next) => {
    try {
      if (!request.account?.roles.includes('SELLER')) {
        response.status(403).json({ error: { code: 'SELLER_ROLE_REQUIRED', message: 'A seller role is required' } });
        return;
      }
      const result = await pool.query<{ bank_code: string; bank_name: string; verified_account_name: string; encrypted_destination: string }>(
        'select bank_code, bank_name, verified_account_name, encrypted_destination from account_payout_destinations where account_id = $1',
        [request.account.id],
      );
      const row = result.rows[0];
      if (!row) {
        response.status(200).json({ payout_destination: null });
        return;
      }
      const destination = JSON.parse(decryptSecret(row.encrypted_destination, APPLICATION_SECRET)) as { accountNumber: string };
      response.status(200).json({ payout_destination: {
        bank_code: row.bank_code,
        bank_name: row.bank_name,
        account_name: row.verified_account_name,
        account_number_last4: destination.accountNumber.slice(-4),
      } });
    } catch (error) { next(error); }
  });

  router.put('/', requireSameOrigin, async (request, response, next) => {
    try {
      if (!request.account?.roles.includes('SELLER')) {
        response.status(403).json({ error: { code: 'SELLER_ROLE_REQUIRED', message: 'A seller role is required' } });
        return;
      }
      const input = destinationSchema.parse(request.body);
      const verified = await nomba.lookupBankAccount(input.account_number, input.bank_code);
      const encrypted = encryptSecret(JSON.stringify({ accountNumber: input.account_number }), APPLICATION_SECRET);
      await pool.query(
        `insert into account_payout_destinations (account_id, bank_code, bank_name, verified_account_name, encrypted_destination, verified_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (account_id) do update set bank_code = excluded.bank_code, bank_name = excluded.bank_name,
           verified_account_name = excluded.verified_account_name, encrypted_destination = excluded.encrypted_destination,
           verified_at = now(), updated_at = now()`,
        [request.account.id, input.bank_code, input.bank_name, verified.accountName, encrypted],
      );
      response.status(200).json({ payout_destination: {
        bank_code: input.bank_code,
        bank_name: input.bank_name,
        account_name: verified.accountName,
        account_number_last4: input.account_number.slice(-4),
      } });
    } catch (error) { next(error); }
  });

  return router;
}