export type WhatsAppTemplateKey =
  | 'account_update'
  | 'opt_out_confirmation'
  | 'payment_ready'
  | 'payout_requested'
  | 'payout_returned'
  | 'refund_update'
  | 'transaction_funded'
  | 'transaction_disputed'
  | 'transaction_update'
  | 'verification_code'
  | 'recovery_code';

export interface WhatsAppTemplate {
  name: string;
  language: 'en';
  parameters: string[];
}

const templateNames: Record<WhatsAppTemplateKey, string> = {
  account_update: 'verispon_account_update',
  opt_out_confirmation: 'verispon_opt_out_confirmation',
  payment_ready: 'verispon_payment_ready',
  payout_requested: 'verispon_payout_requested',
  payout_returned: 'verispon_payout_returned',
  refund_update: 'verispon_refund_update',
  transaction_funded: 'verispon_transaction_funded',
  transaction_disputed: 'verispon_transaction_disputed',
  transaction_update: 'verispon_transaction_update',
  verification_code: 'verispon_verification_code',
  recovery_code: 'verispon_recovery_code',
};

export function registeredWhatsAppTemplate(
  key: WhatsAppTemplateKey,
  parameters: string[] = [],
): WhatsAppTemplate {
  return { name: templateNames[key], language: 'en', parameters };
}
