import amqp from 'amqplib';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

let connection: amqp.ChannelModel | null = null;
let confirmChannel: amqp.ConfirmChannel | null = null;
let isConnecting = false;
let isClosing = false;

/**
 * Strips password and sensitive auth credentials from AMQP URL for structured logging.
 */
export function sanitizeAmqpUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return 'amqp://***:***@host:port';
  }
}

/**
 * Creates or retrieves the singleton RabbitMQ connection with bounded exponential backoff.
 */
export async function getRabbitMQConnection(): Promise<amqp.ChannelModel> {
  if (connection && !isClosing) {
    return connection;
  }

  if (isConnecting) {
    // Wait for in-flight connection attempt
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (connection) return connection;
    }
  }

  isConnecting = true;
  isClosing = false;

  const url = env.RABBITMQ_URL;
  const sanitizedUrl = sanitizeAmqpUrl(url);

  let attempt = 0;
  const maxAttempts = 10;
  const baseDelayMs = 200;
  const maxDelayMs = 5000;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      logger.info(`Connecting to RabbitMQ at ${sanitizedUrl} (attempt ${attempt}/${maxAttempts})...`);
      const conn = await amqp.connect(url, {
        clientProperties: {
          connection_name: 'dropshield-backend',
        },
      });

      conn.on('error', (err) => {
        logger.error('RabbitMQ connection error:', err.message);
      });

      conn.on('close', () => {
        if (!isClosing) {
          logger.warn('RabbitMQ connection closed unexpectedly. Invalidating cached connection.');
        } else {
          logger.info('RabbitMQ connection closed cleanly.');
        }
        connection = null;
        confirmChannel = null;
      });

      connection = conn;
      isConnecting = false;
      logger.info('RabbitMQ connection established successfully.');
      return conn;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(`RabbitMQ connection attempt ${attempt} failed: ${errMsg}`);
      if (attempt >= maxAttempts) {
        isConnecting = false;
        throw new Error(`Failed to connect to RabbitMQ after ${maxAttempts} attempts: ${errMsg}`);
      }
      // Bounded exponential backoff with jitter
      const jitter = Math.random() * 200;
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt) + jitter, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  isConnecting = false;
  throw new Error('RabbitMQ connection failed');
}

/**
 * Returns a singleton RabbitMQ ConfirmChannel for publishing persistent messages with publisher confirms.
 */
export async function getRabbitMQConfirmChannel(): Promise<amqp.ConfirmChannel> {
  if (confirmChannel) {
    return confirmChannel;
  }

  const conn = await getRabbitMQConnection();
  const channel = await conn.createConfirmChannel();

  channel.on('error', (err) => {
    logger.error('RabbitMQ confirm channel error:', err.message);
  });

  channel.on('close', () => {
    if (!isClosing) {
      logger.warn('RabbitMQ confirm channel closed. Invalidating cached channel.');
    }
    confirmChannel = null;
  });

  confirmChannel = channel;
  return channel;
}

/**
 * Perform a live RabbitMQ health check without leaking credentials.
 */
export async function checkRabbitMQHealth(): Promise<{
  status: 'up' | 'down';
  latencyMs?: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    const conn = await getRabbitMQConnection();
    const tempChannel = await conn.createChannel();
    await tempChannel.checkExchange('amq.direct');
    await tempChannel.close();
    const latencyMs = Date.now() - start;
    return { status: 'up', latencyMs };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'down', error: msg };
  }
}

/**
 * Graceful shutdown for RabbitMQ connection and channels.
 */
export async function closeRabbitMQClient(): Promise<void> {
  isClosing = true;
  try {
    if (confirmChannel) {
      try {
        await confirmChannel.close();
      } catch {
        // channel may already be closed
      }
      confirmChannel = null;
    }

    if (connection) {
      try {
        (connection as any).removeAllListeners?.();
        await connection.close();
      } catch {
        // connection may already be closed
      }
      connection = null;
    }
    logger.info('RabbitMQ connection and channels closed.');
  } finally {
    isClosing = false;
  }
}
