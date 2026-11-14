import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { PaymentService } from '../services/payment/payment.service.js';
import { DevPaymentProvider } from '../services/payment/dev-payment.provider.js';
import { logger } from '../utils/logger.js';

export const paymentsRouter = Router();

const devProvider = new DevPaymentProvider();
const paymentService = new PaymentService(devProvider);

const uuidParamSchema = z.string().uuid({ message: 'Invalid UUID identifier' });

const initPaymentBodySchema = z.object({
  idempotencyKey: z.string().min(8).optional(),
  simulateSuccess: z.boolean().optional(),
});

/**
 * POST /api/v1/reservations/:reservationId/payments
 * Initialize payment for a pending reservation.
 */
paymentsRouter.post('/reservations/:reservationId/payments', requireAuth, async (req: Request, res: Response) => {
  const paramResult = uuidParamSchema.safeParse(req.params.reservationId);
  if (!paramResult.success) {
    res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_RESERVATION_ID',
        message: 'Invalid reservation ID parameter format',
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const reservationId = paramResult.data;
  const userId = req.user!.id;

  const bodyResult = initPaymentBodySchema.safeParse(req.body);
  const idempotencyKey =
    req.header('x-idempotency-key') ||
    (bodyResult.success && bodyResult.data.idempotencyKey) ||
    `pay_${reservationId}_${Date.now()}`;
  const simulateSuccess = bodyResult.success ? bodyResult.data.simulateSuccess : undefined;

  try {
    const result = await paymentService.initializePayment({
      reservationId,
      userId,
      idempotencyKey,
      simulateSuccess,
    });

    res.status(200).json({
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Payment initialization failed for reservation ${reservationId}:`, msg);

    if (msg === 'RESERVATION_NOT_FOUND') {
      res.status(404).json({
        success: false,
        error: { code: 'RESERVATION_NOT_FOUND', message: 'Reservation not found' },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (msg === 'FORBIDDEN_RESERVATION') {
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Not authorized for this reservation' },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (msg === 'RESERVATION_EXPIRED') {
      res.status(410).json({
        success: false,
        error: { code: 'RESERVATION_EXPIRED', message: 'Reservation lease has expired' },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (msg.startsWith('RESERVATION_NOT_PAYABLE')) {
      res.status(409).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: msg },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: { code: 'PAYMENT_INIT_ERROR', message: 'Failed to initialize payment' },
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * POST /api/v1/payments/webhook
 * Public webhook endpoint for payment providers.
 * Validates HMAC-SHA256 signature and executes durable state transitions.
 */
paymentsRouter.post('/payments/webhook', async (req: Request, res: Response) => {
  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

  const verification = await devProvider.verifyWebhook({
    rawBody,
    headers: req.headers as Record<string, string | string[] | undefined>,
  });

  if (!verification.isValid) {
    logger.warn(`Invalid payment webhook: ${verification.failureReason}`);
    res.status(401).json({
      success: false,
      error: { code: 'INVALID_SIGNATURE', message: verification.failureReason || 'Invalid webhook signature' },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const payload = req.body;
  const event = verification.event;
  const data = payload.data || {};

  try {
    if (event === 'payment.succeeded') {
      const { reservationId, userId, providerPaymentId, amountMinor, currency } = data;
      await paymentService.finalizePaymentSuccess({
        reservationId,
        userId,
        providerPaymentId,
        amountMinor,
        currency,
      });
      logger.info(`Webhook successfully processed payment.succeeded for reservation ${reservationId}`);
    } else if (event === 'payment.failed') {
      const { reservationId, userId, reason } = data;
      await paymentService.handlePaymentFailure({
        reservationId,
        userId,
        failureReason: reason || 'Payment declined by provider',
      });
      logger.info(`Webhook processed payment.failed for reservation ${reservationId}`);
    }

    res.status(200).json({ received: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Error processing payment webhook:', msg);
    res.status(500).json({
      success: false,
      error: { code: 'WEBHOOK_PROCESSING_ERROR', message: msg },
      timestamp: new Date().toISOString(),
    });
  }
});
