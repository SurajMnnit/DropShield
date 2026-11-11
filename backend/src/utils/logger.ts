export const logger = {
  info: (message: string, ...meta: unknown[]): void => {
    console.log(`[${new Date().toISOString()}] [INFO] ${message}`, ...meta);
  },
  warn: (message: string, ...meta: unknown[]): void => {
    console.warn(`[${new Date().toISOString()}] [WARN] ${message}`, ...meta);
  },
  error: (message: string, ...meta: unknown[]): void => {
    console.error(`[${new Date().toISOString()}] [ERROR] ${message}`, ...meta);
  },
  debug: (message: string, ...meta: unknown[]): void => {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(`[${new Date().toISOString()}] [DEBUG] ${message}`, ...meta);
    }
  },
};
