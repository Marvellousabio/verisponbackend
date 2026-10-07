import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

interface NombaEnvelope<T> {
  code: string;
  description?: string;
  data: T;
}

interface NombaTokenData {
  access_token: string;
  expiresAt: string;
}

export interface NombaCheckoutOrder {
  checkoutLink: string;
  orderReference: string;
}

export interface NombaVerifiedTransaction {
  status: string;
  amount?: string | number;
  onlineCheckoutAmount?: string | number;
  id?: string;
}

export interface NombaTransferResult {
  id: string;
  status: string;
}

export interface NombaWebhook {
  event_type: string;
  requestId: string;
  data: {
    merchant?: { userId?: string; walletId?: string };
    transaction?: {
      transactionId?: string;
      type?: string;
      time?: string;
      responseCode?: string | null;
      merchantTxRef?: string;
    };
    order?: { orderReference?: string; amount?: string | number; currency?: string; orderMetaData?: Record<string, string> };
  };
}

export class NombaAdapter {
  private cachedAccessToken: string | null = null;
  private tokenExpiresAt = 0;
  private tokenRequest: Promise<string> | null = null;

  isConfigured(): boolean {
    return Boolean(config.NOMBA_ACCOUNT_ID && config.NOMBA_CLIENT_ID && config.NOMBA_CLIENT_SECRET && config.NOMBA_WEBHOOK_SECRET);
  }

  verifyWebhook(payload: NombaWebhook, signatureHeader: string | undefined, timestampHeader: string | undefined): boolean {
    if (!config.NOMBA_WEBHOOK_SECRET || !signatureHeader || !timestampHeader || !payload?.data) return false;
    return verifyNombaSignature(payload, config.NOMBA_WEBHOOK_SECRET, signatureHeader, timestampHeader);
  }

  async verifyTransaction(orderReference: string): Promise<NombaVerifiedTransaction> {
    const url = new URL('/v1/transactions/accounts/single', config.NOMBA_API_BASE_URL);
    url.searchParams.set('orderReference', orderReference);
    const result = await this.request<NombaEnvelope<NombaVerifiedTransaction>>(url.pathname + url.search, { method: 'GET' });
    if (result.code !== '00' || !result.data) throw new Error(`Nomba could not verify the payment: ${result.description ?? result.code}`);
    return result.data;
  }

  async verifyTransfer(merchantTxRef: string): Promise<NombaVerifiedTransaction> {
    const url = new URL('/v1/transactions/accounts/single', config.NOMBA_API_BASE_URL);
    url.searchParams.set('merchantTxRef', merchantTxRef);
    const result = await this.request<NombaEnvelope<NombaVerifiedTransaction>>(url.pathname + url.search, { method: 'GET' });
    if (result.code !== '00' || !result.data) throw new Error(`Nomba could not verify the transfer: ${result.description ?? result.code}`);
    return result.data;
  }

  async createCheckout(input: { orderReference: string; amountKobo: bigint; customerEmail: string; transactionId: string }): Promise<NombaCheckoutOrder> {
    const callbackUrl = `${config.WEB_ORIGIN}/?payment=returned`;
    const result = await this.request<NombaEnvelope<NombaCheckoutOrder>>('/v1/checkout/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order: {
          orderReference: input.orderReference,
          customerId: input.transactionId,
          callbackUrl,
          customerEmail: input.customerEmail,
          amount: this.formatNaira(input.amountKobo),
          currency: 'NGN',
          orderMetaData: { transaction_id: input.transactionId, verispon_reference: input.orderReference },
        },
      }),
    });
    if (result.code !== '00' || !result.data?.checkoutLink || !result.data.orderReference) {
      throw new Error(`Nomba checkout order failed: ${result.description ?? result.code}`);
    }
    return result.data;
  }

  async lookupBankAccount(accountNumber: string, bankCode: string): Promise<{ accountName: string }> {
    const result = await this.request<NombaEnvelope<{ accountName: string }>>('/v1/transfers/bank/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountNumber, bankCode }),
    });
    if (result.code !== '00' || !result.data?.accountName) throw new Error(`Nomba bank lookup failed: ${result.description ?? result.code}`);
    return result.data;
  }

  async transferToBank(input: {
    amountKobo: bigint;
    accountNumber: string;
    accountName: string;
    bankCode: string;
    merchantTxRef: string;
    narration: string;
  }): Promise<NombaTransferResult> {
    const result = await this.request<NombaEnvelope<NombaTransferResult>>('/v2/transfers/bank', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: nombaAmountToNairaNumber(input.amountKobo),
        accountNumber: input.accountNumber,
        accountName: input.accountName,
        bankCode: input.bankCode,
        merchantTxRef: input.merchantTxRef,
        senderName: 'Verispon Escrow',
        narration: input.narration,
      }),
    });
    if (!result.data?.id) throw new Error(`Nomba transfer response is missing an id: ${result.description ?? result.code}`);
    return result.data;
  }

  async refundCheckout(providerTransactionId: string, refundKobo: bigint): Promise<void> {
    const result = await this.request<NombaEnvelope<{ success?: boolean; message?: string }>>('/v1/checkout/refund', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transactionId: providerTransactionId,
        amount: Number(this.formatNaira(refundKobo)),
      }),
    });
    if (result.code !== '00' || result.data?.success === false) {
      throw new Error(`Nomba refund was not accepted: ${result.description ?? result.data?.message ?? result.code}`);
    }
  }

  private formatNaira(amountKobo: bigint): string {
    if (amountKobo <= 0n) throw new RangeError('Nomba amount must be positive');
    return `${amountKobo / 100n}.${(amountKobo % 100n).toString().padStart(2, '0')}`;
  }

  private async accessToken(): Promise<string> {
    if (this.cachedAccessToken && this.tokenExpiresAt - Date.now() > 5 * 60_000) return this.cachedAccessToken;
    if (this.tokenRequest) return this.tokenRequest;
    if (!config.NOMBA_ACCOUNT_ID || !config.NOMBA_CLIENT_ID || !config.NOMBA_CLIENT_SECRET) {
      throw new Error('Nomba credentials are not configured');
    }
    this.tokenRequest = (async () => {
      const response = await fetch(new URL('/v1/auth/token/issue', config.NOMBA_API_BASE_URL), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', accountId: config.NOMBA_ACCOUNT_ID! },
        body: JSON.stringify({ grant_type: 'client_credentials', client_id: config.NOMBA_CLIENT_ID, client_secret: config.NOMBA_CLIENT_SECRET }),
      });
      if (!response.ok) throw new Error(`Nomba authentication failed (${response.status})`);
      const result = await response.json() as NombaEnvelope<NombaTokenData>;
      if (result.code !== '00' || !result.data?.access_token) throw new Error('Nomba authentication was rejected');
      this.cachedAccessToken = result.data.access_token;
      this.tokenExpiresAt = Date.parse(result.data.expiresAt) || Date.now() + 25 * 60_000;
      return this.cachedAccessToken;
    })().finally(() => { this.tokenRequest = null; });
    return this.tokenRequest;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const token = await this.accessToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('accountId', config.NOMBA_ACCOUNT_ID!);
    const response = await fetch(new URL(path, config.NOMBA_API_BASE_URL), { ...init, headers, signal: AbortSignal.timeout(15_000) });
    const body = await response.json() as T;
    if (!response.ok) throw new Error(`Nomba API request failed (${response.status})`);
    return body;
  }
}

export function verifyNombaSignature(payload: NombaWebhook, secret: string, suppliedSignature: string, timestamp: string): boolean {
  const transaction = payload.data.transaction ?? {};
  const merchant = payload.data.merchant ?? {};
  const responseCode = transaction.responseCode === 'null' ? '' : transaction.responseCode ?? '';
  const hashingPayload = [
    payload.event_type ?? '', payload.requestId ?? '', merchant.userId ?? '', merchant.walletId ?? '',
    transaction.transactionId ?? '', transaction.type ?? '', transaction.time ?? '', responseCode, timestamp,
  ].join(':');
  const expected = createHmac('sha256', secret).update(hashingPayload).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(suppliedSignature, 'base64'); } catch { return false; }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function nombaAmountToKobo(value: string | number | undefined): bigint {
  const text = String(value ?? '');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new RangeError('Nomba returned an invalid NGN amount');
  return BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
}

export function nombaAmountToNairaNumber(amountKobo: bigint): number {
  if (amountKobo <= 0n) throw new RangeError('Nomba amount must be positive');
  const naira = `${amountKobo / 100n}.${(amountKobo % 100n).toString().padStart(2, '0')}`;
  const numericAmount = Number(naira);
  if (!Number.isFinite(numericAmount) || nombaAmountToKobo(numericAmount) !== amountKobo) {
    throw new RangeError('Nomba transfer amount cannot be represented exactly as a decimal number');
  }
  return numericAmount;
}