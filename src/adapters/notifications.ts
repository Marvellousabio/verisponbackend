import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export class WhatsAppCloudAdapter {
  isConfigured(): boolean {
    return Boolean(config.META_WHATSAPP_TOKEN && config.META_WHATSAPP_PHONE_NUMBER_ID);
  }

  verifySignature(rawBody: Buffer, header: string | undefined): boolean {
    if (!config.META_APP_SECRET || !header?.startsWith('sha256=')) return false;
    const supplied = Buffer.from(header.slice(7), 'hex');
    const expected = createHmac('sha256', config.META_APP_SECRET).update(rawBody).digest();
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  async sendText(to: string, body: string): Promise<void> {
    if (!this.isConfigured()) throw new Error('Meta WhatsApp Cloud API is not configured');
    const url = 'https://graph.facebook.com/'
      + config.META_GRAPH_VERSION
      + '/'
      + config.META_WHATSAPP_PHONE_NUMBER_ID
      + '/messages';
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.META_WHATSAPP_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body },
      }),
    });
    if (!response.ok) throw new Error('WhatsApp send failed (' + response.status + ')');
  }

  async sendTemplate(
    to: string,
    template: { name: string; language: string; parameters: string[] },
  ): Promise<void> {
    if (!this.isConfigured()) throw new Error('Meta WhatsApp Cloud API is not configured');
    const url = 'https://graph.facebook.com/'
      + config.META_GRAPH_VERSION
      + '/'
      + config.META_WHATSAPP_PHONE_NUMBER_ID
      + '/messages';
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.META_WHATSAPP_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'template',
        template: {
          name: template.name,
          language: { code: template.language },
          ...(template.parameters.length ? {
            components: [{
              type: 'body',
              parameters: template.parameters.map((text) => ({ type: 'text', text })),
            }],
          } : {}),
        },
      }),
    });
    if (!response.ok) throw new Error('WhatsApp template send failed (' + response.status + ')');
  }
}

export class ResendEmailAdapter {
  async send(to: string, subject: string, text: string): Promise<void> {
    if (!config.RESEND_API_KEY || !config.RESEND_FROM_EMAIL) throw new Error('Resend is not configured');
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: config.RESEND_FROM_EMAIL, to: [to], subject, text }),
    });
    if (!response.ok) throw new Error('Resend send failed (' + response.status + ')');
  }
}
