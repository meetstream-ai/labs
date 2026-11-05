/**
 * Logger - coloured terminal output for MeetStream Labs
 */

import chalk from "chalk";

const ts = () => chalk.dim(new Date().toLocaleTimeString());

export class Logger {
  banner() {
    console.log(
      chalk.bold.cyan(`
╔══════════════════════════════════════════════════════╗
║         MeetStream Labs - Real-Time Audio            ║
║         github.com/meetstream-labs/audio-example     ║
╚══════════════════════════════════════════════════════╝
`)
    );
  }

  info(msg)    { console.log(`${ts()} ${chalk.blue("ℹ")}  ${msg}`); }
  success(msg) { console.log(`${ts()} ${chalk.green("✔")}  ${msg}`); }
  error(msg, err) {
    console.error(`${ts()} ${chalk.red("✖")}  ${msg}`, err?.message ?? "");
  }

  audio(msg)   { console.log(`${ts()} ${chalk.magenta("♪")}  ${msg}`); }

  /**
   * Live transcript segment
   * { speakerName, transcript, timestamp, words }
   */
  transcript(speaker, text, _timestamp, words) {
    const confidence = words?.length
      ? (words.reduce((s, w) => s + (w.confidence ?? 1), 0) / words.length).toFixed(2)
      : "-";
    console.log(
      `${ts()} ${chalk.bold.yellow(speaker?.padEnd(16) ?? "Unknown")} ` +
      `${chalk.white(text)} ${chalk.dim(`[conf: ${confidence}]`)}`
    );
  }

  /**
   * Bot lifecycle / participant event
   * { bot_id, event, bot_event, bot_status, message, status_code, ... }
   *
   * `event` is the generic name; `bot_event` is the specific one and, on a
   * terminal `bot.stopped` delivery, carries the reason (bot.stopped,
   * bot.kicked, bot.notallowed, bot.denied, bot.failed). `bot.done` is the
   * final event on every path, streaming bots included.
   */
  event(payload) {
    const { event, bot_event, bot_status, message, status_code } = payload;

    const statusColor =
      status_code === 200 ? chalk.green :
      status_code === 102 ? chalk.yellow :
      chalk.red;

    let label = bot_event ?? event ?? bot_status ?? "event";
    if (event === "bot.stopped" && !bot_event) {
      // Fallback only when bot_event is missing: bot_status, case-insensitive.
      const status = String(bot_status ?? "").toLowerCase();
      label =
        status === "notallowed" ? "bot.notallowed" :
        status === "denied" ? "bot.denied" :
        status === "error" || status === "failed" ? "bot.failed" :
        "bot.stopped";
    }
    label = label.padEnd(28);
    console.log(
      `${ts()} ${statusColor(label)} ${chalk.dim(message ?? "")}`
    );

    // If the bot just joined, celebrate
    if (event === "bot.inmeeting") {
      console.log(chalk.bold.green("\n  Bot is LIVE in the meeting! Audio streaming now.\n"));
    }
  }
}
