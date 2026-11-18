type Level = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = RANK.info;

export function setLogLevel(level: Level): void {
  threshold = RANK[level];
}

function emit(level: Level, message: string, context?: Record<string, unknown>): void {
  if (RANK[level] < threshold) return;
  // Context is spread first so a payload field named "message" cannot clobber ours.
  const line = { level, time: new Date().toISOString(), ...context, message };
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => emit('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) => emit('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => emit('error', message, context),
};
