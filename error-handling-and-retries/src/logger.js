const ESC = String.fromCharCode(27); // ANSI escape

const C = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  bold: `${ESC}[1m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  cyan: `${ESC}[36m`,
};

const useColor = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
const paint = (code, s) => (useColor ? `${code}${s}${C.reset}` : String(s));

const ts = () => new Date().toISOString().slice(11, 23);

export const log = {
  info: (msg, ...rest) => console.log(`${paint(C.dim, ts())} ${msg}`, ...rest),
  ok: (msg, ...rest) =>
    console.log(`${paint(C.dim, ts())} ${paint(C.green, 'OK  ')} ${msg}`, ...rest),
  warn: (msg, ...rest) =>
    console.warn(`${paint(C.dim, ts())} ${paint(C.yellow, 'WARN')} ${msg}`, ...rest),
  error: (msg, ...rest) =>
    console.error(`${paint(C.dim, ts())} ${paint(C.red, 'ERR ')} ${msg}`, ...rest),
  event: (name, botId, msg) =>
    console.log(
      `${paint(C.dim, ts())} ${paint(C.cyan, String(name).padEnd(24))} ${paint(C.dim, botId)} ${msg}`,
    ),
  banner: (title) => {
    const line = '='.repeat(Math.max(8, title.length + 4));
    console.log(`\n${paint(C.bold, line)}\n${paint(C.bold, `  ${title}`)}\n${paint(C.bold, line)}`);
  },
  detail: (label, value) => console.log(`${' '.repeat(13)}${paint(C.dim, `${label}:`)} ${value}`),
};

export { paint, C as colors };
