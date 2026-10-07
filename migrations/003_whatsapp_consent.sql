alter table accounts
  add column whatsapp_consent_at timestamptz,
  add column whatsapp_opted_out_at timestamptz;