export interface CreatePaymentParams {
  paymentId: string;
  reservationId: string;
  userId: string;
  amountMinor: number;
  currency: string;
  description: string;
  metadata?: Record<string, unknown>;
}

export interface CreatePaymentResult {
  provider: string;
  providerPaymentId: string;
  clientSecret?: string;
  checkoutUrl?: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  rawResponse?: unknown;
}

export interface VerifyWebhookParams {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string | Buffer;
}

export interface WebhookVerificationResult {
  isValid: boolean;
  event: 'payment.succeeded' | 'payment.failed' | 'payment.refunded' | 'unknown';
  providerPaymentId: string;
  amountMinor: number;
  currency: string;
  failureReason?: string;
}

export interface ProcessRefundParams {
  paymentId: string;
  providerPaymentId: string;
  amountMinor: number;
  reason?: string;
}

export interface ProcessRefundResult {
  success: boolean;
  refundId: string;
  status: 'REFUNDED' | 'FAILED';
  error?: string;
}

export interface PaymentProvider {
  readonly providerName: string;

  createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult>;

  verifyWebhook(params: VerifyWebhookParams): Promise<WebhookVerificationResult>;

  processRefund(params: ProcessRefundParams): Promise<ProcessRefundResult>;
}
