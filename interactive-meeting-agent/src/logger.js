/**
 * Zero-dependency terminal logger.
 *
 * Colour is disabled automatically when stdout is not a TTY, or when NO_COLOR
 * is set, so piping output to a file stays readable.
 */

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

const COLOR = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;

export function c(name, value) {
  const code = ANSI[name];
  return COLOR && code ? `${code}${value}${ANSI.reset}` : String(value);
}

const stamp = () => c("dim", new Date().toLocaleTimeString());

export const log = {
  banner(title, subtitle) {
    const width = Math.max(title.length, (subtitle ?? "").length) + 4;
    console.log("");
    console.log(c("cyan", "─".repeat(width)));
    console.log(`  ${c("bold", title)}`);
    if (subtitle) console.log(`  ${c("dim", subtitle)}`);
    console.log(c("cyan", "─".repeat(width)));
    console.log("");
  },

  info(msg) {
    console.log(`${stamp()} ${c("blue", "i ")} ${msg}`);
  },

  success(msg) {
    console.log(`${stamp()} ${c("green", "ok")} ${msg}`);
  },

  warn(msg) {
    console.log(`${stamp()} ${c("yellow", "! ")} ${msg}`);
  },

  error(msg, err) {
    const extra = err ? ` ${c("dim", err.message ?? String(err))}` : "";
    console.error(`${stamp()} ${c("red", "x ")} ${msg}${extra}`);
  },

  detail(msg) {
    console.log(`${stamp()} ${c("dim", "·  " + msg)}`);
  },

  /**
   * Pretty-print a MeetStream webhook payload.
   * Envelope key is `event` (never `bot_event`).
   */
  event(payload) {
    const { event, bot_status, message, status_code } = payload ?? {};
    const label = String(event ?? bot_status ?? "event").padEnd(24);
    const colour = status_code === 500 ? "red" : status_code === 200 ? "green" : "yellow";
    console.log(`${stamp()} ${c(colour, label)} ${c("dim", message ?? "")}`);
  },
};
