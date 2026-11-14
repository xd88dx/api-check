import { appendFileSync, mkdirSync } from 'node:fs';

const LOG_DIR = 'data/logs';
const LOG_FILE = `${LOG_DIR}/start.log`;

let logDirReady = false;
function ensureLogDir(): void {
  if (logDirReady) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    logDirReady = true;
  } catch {
    logDirReady = true;
  }
}

type Level = 'info' | 'warn' | 'error';

function write(level: Level, message: string, meta?: unknown): void {
  ensureLogDir();
  const time = new Date().toISOString();
  const metaStr = meta !== undefined ? ' ' + JSON.stringify(meta) : '';
  const line = `[${time}] [${level.toUpperCase()}] ${message}${metaStr}`;
  // 双输出：console + 文件追加
  // eslint-disable-next-line no-console
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + '\n');
  } catch {
    // 忽略写日志失败
  }
}

export const logger = {
  info: (msg: string, meta?: unknown) => write('info', msg, meta),
  warn: (msg: string, meta?: unknown) => write('warn', msg, meta),
  error: (msg: string, meta?: unknown) => write('error', msg, meta),
};
