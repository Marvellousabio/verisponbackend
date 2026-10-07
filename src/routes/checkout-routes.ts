import { Router } from 'express';
import type { CheckoutService } from '../services/checkout-service.js';

/**
 * The one unauthenticated read in the API.
 *
 * The token *is* the credential, so there is no `requireAuth` here by design —
 * the buyer paying for the first time has no account. That makes this route the
 * place most likely to be mistaken for a hole, so two things are load-bearing:
 * a 32-hex check before any query, and a response that carries the deal and the
 * price and nothing about the people.
 *
 * It cannot mark a transaction paid. FUNDED is engine-only, because "the money
 * arrived" is a fact about a bank rather than something a browser may assert.
 */
export function createCheckoutRouter(checkout: CheckoutService) {
  const router = Router();

  router.get('/checkout/:token', async (request, response, next) => {
    try {
      const view = await checkout.view(request.params.token);
      if (!view) {
        // Deliberately flat: a 404 tells a prober nothing about whether any
        // token was ever issued, and a page that looks live but cannot take
        // money is worse than a plain dead link.
        response.status(404).json({ error: { code: 'NOT_FOUND', message: 'This payment link is not valid.' } });
        return;
      }
      response.setHeader('X-Robots-Tag', 'noindex, nofollow');
      response.setHeader('Cache-Control', 'private, no-store');
      response.status(200).json(view);
    } catch (error) { next(error); }
  });

  return router;
}
