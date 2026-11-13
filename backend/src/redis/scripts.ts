import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import type { Redis } from 'ioredis';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Locate lua directory
const LUA_DIR = path.resolve(__dirname, 'lua');

export interface LuaScriptMetadata {
  name: string;
  code: string;
  sha1: string;
}

// In-memory cache of loaded Lua scripts
const scriptsCache: Record<string, LuaScriptMetadata> = {};

function loadScript(filename: string): LuaScriptMetadata {
  const name = filename.replace('.lua', '');
  if (scriptsCache[name]) {
    return scriptsCache[name];
  }

  const filePath = path.join(LUA_DIR, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Lua script not found at path: ${filePath}`);
  }

  const code = fs.readFileSync(filePath, 'utf8');
  const sha1 = crypto.createHash('sha1').update(code, 'utf8').digest('hex');
  const meta: LuaScriptMetadata = { name, code, sha1 };
  scriptsCache[name] = meta;
  return meta;
}

export function getLuaScripts(): {
  holdSeats: LuaScriptMetadata;
  releaseSeats: LuaScriptMetadata;
  confirmSeats: LuaScriptMetadata;
} {
  return {
    holdSeats: loadScript('hold_seats.lua'),
    releaseSeats: loadScript('release_seats.lua'),
    confirmSeats: loadScript('confirm_seats.lua'),
  };
}

/**
 * Executes a Lua script using EVALSHA with automatic fallback to EVAL on NOSCRIPT error.
 */
export async function executeLuaScript<T>(
  redis: Redis,
  scriptMeta: LuaScriptMetadata,
  keys: string[],
  args: (string | number)[]
): Promise<T> {
  const stringArgs = args.map(String);
  try {
    const rawResult = await redis.evalsha(scriptMeta.sha1, keys.length, ...keys, ...stringArgs);
    return JSON.parse(rawResult as string) as T;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes('NOSCRIPT')) {
      logger.info(`Script ${scriptMeta.name} not cached on Redis server. Re-evaluating via EVAL and caching...`);
      const rawResult = await redis.eval(scriptMeta.code, keys.length, ...keys, ...stringArgs);
      return JSON.parse(rawResult as string) as T;
    }
    throw err;
  }
}
