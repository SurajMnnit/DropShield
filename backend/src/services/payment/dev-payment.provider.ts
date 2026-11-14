import crypto from 'crypto';
import { failureInjector } from '../../testing/failure-injector.js';
import type {
  PaymentProvider,
  CreatePaymentParams,
  CreatePaymentResult,
  VerifyWebhookParams,
  WebhookVerificationResult,
  ProcessRefundParams,
  ProcessRefundResult,
} from './payment-provider.interface.js';

export const DEV_PAYMENT_WEBHOOK_SECRET =
  process.env.PAYMENT_WEBHOOK_SECRET || 'dev_mock_payment_webhook_secret_key_32chars';

/**
 * DevPaymentProvider
 * Simulated payment provider for development and automated testing.
 * NOTE: This provider simulates transactions in memory and DOES NOT process real funds.
 */
export class DevPaymentProvider implements PaymentProvider {
  readonly providerName = 'DEV_MOCK_GATEWAY';

  async createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult> {
    await failureInjector.trigger('PAYMENT_PROVIDER_TIMEOUT');
    await failureInjector.trigger('PAYMENT_AMBIGUOUS_RESULT');

    const providerPaymentId = `mock_pay_${crypto.randomUUID()}`;
    const clientSecret = `mock_sec_${crypto.randomBytes(16).toString('hex')}`;

    // Immediate simulated outcome if specified in metadata
    const simulateStatus = params.metadata?.simulateImmediateSuccess ? 'SUCCEEDED' : 'PENDING';

    return {
      provider: this.providerName,
      providerPaymentId,
      clientSecret,
      checkoutUrl: `/checkout/simulated?payment_id=${providerPaymentId}`,
      status: simulateStatus,
      rawResponse: {
        mocked: true,
        reference: params.paymentId,
      },
    };
  }

  /**
   * Helper to sign payloads for integration tests.
   */
  static signPayload(rawBody: string, secret = DEV_PAYMENT_WEBHOOK_SECRET): string {
    return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  }

  async verifyWebhook(params: VerifyWebhookParams): Promise<WebhookVerificationResult> {
    const bodyStr = typeof params.rawBody === 'string' ? params.rawBody : params.rawBody.toString('utf-8');
    const signature =
      (params.headers['x-dropshield-signature'] as string) ||
      (params.headers['x-webhook-signature'] as string);

    if (!signature) {
      return {
        isValid: false,
        event: 'unknown',
        providerPaymentId: '',
        amountMinor: 0,
        currency: 'INR',
        failureReason: 'Missing webhook signature header',
      };
    }

    const expectedSignature = DevPaymentProvider.signPayload(bodyStr);
    const sigBuf = Buffer.from(signature, 'utf-8');
    const expBuf = Buffer.from(expectedSignature, 'utf-8');

    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return {
        isValid: false,
        event: 'unknown',
        providerPaymentId: '',
        amountMinor: 0,
        currency: 'INR',
        failureReason: 'Invalid webhook signature',
      };
    }

    let parsedPayload: Record<string, any>;
    try {
      parsedPayload = JSON.parse(bodyStr);
    } catch {
      return {
        isValid: false,
        event: 'unknown',
        providerPaymentId: '',
        amountMinor: 0,
        currency: 'INR',
        failureReason: 'Malformed JSON webhook payload',
      };
    }

    return {
      isValid: true,
      event: parsedPayload.event || 'payment.succeeded',
      providerPaymentId: parsedPayload.providerPaymentId,
      amountMinor: parsedPayload.amountMinor || 0,
      currency: parsedPayload.currency || 'INR',
      failureReason: parsedPayload.failureReason,
    };
  }

  async processRefund(_params: ProcessRefundParams): Promise<ProcessRefundResult> {
    const refundId = `mock_ref_${crypto.randomUUID()}`;
    return {
      success: true,
      refundId,
      status: 'REFUNDED',
    };
  }
}
