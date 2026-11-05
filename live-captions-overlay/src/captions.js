/**
 * A rolling caption overlay for the terminal.
 *
 * Keeps the last N committed caption lines plus one in-progress line, and
 * repaints the whole panel on every update. On a TTY it clears the screen and
 * redraws in place; when stdout is a pipe or a log file it degrades to plain
 * append-only output so nothing is lost.
 */

const CLEAR_SCREEN = "\x1b[2J\x1b[H";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export class CaptionOverlay {
  /**
   * @param {object} [options]
   * @param {number} [options.maxLines]  Committed lines kept on screen
   * @param {number} [options.width]     Wrap width
   * @param {string} [options.title]     Panel header
   */
  constructor(options = {}) {
    const { maxLines = 10, width = 92, title = "LIVE CAPTIONS" } = options;
    this.maxLines = maxLines;
    this.width = width;
    this.title = title;

    this.lines = [];
    this.pending = null;
    this.lastEmitted = null;
    this.status = "waiting for the bot to join...";
    this.chunkCount = 0;
    this.interactive = Boolean(process.stdout.isTTY);
  }

  setStatus(status) {
    this.status = status;
    this.render();
  }

  /**
   * Add or update a caption.
   *
   * @param {object} caption
   * @param {string} caption.speaker
   * @param {string} caption.text
   * @param {string} [caption.timestamp]  ISO 8601 from the chunk
   * @param {boolean} [caption.final]     false → in-progress, replace in place
   */
  push({ speaker, text, timestamp, final = true }) {
    if (!text) return;
    this.chunkCount += 1;

    const line = {
      speaker: speaker || "Unknown",
      text,
      clock: formatClock(timestamp),
    };

    if (!final) {
      this.pending = line;
    } else {
      this.pending = null;
      this.lines.push(line);
      if (this.lines.length > this.maxLines) {
        this.lines.splice(0, this.lines.length - this.maxLines);
      }
    }
    this.render();
  }

  /** Log a lifecycle note above the caption panel. */
  note(message) {
    if (this.interactive) {
      this.lines.push({ speaker: null, text: message, clock: formatClock() });
      if (this.lines.length > this.maxLines) {
        this.lines.splice(0, this.lines.length - this.maxLines);
      }
      this.render();
    } else {
      console.log(`[${formatClock()}] ${message}`);
    }
  }

  render() {
    if (!this.interactive) {
      // Append-only fallback (piped output, log files): emit committed lines
      // only. Repainting is impossible here, and echoing every revision of an
      // in-progress line would bury the real captions.
      const line = this.lines[this.lines.length - 1];
      if (line && line !== this.lastEmitted) {
        this.lastEmitted = line;
        console.log(formatPlain(line));
      }
      return;
    }

    const out = [];
    out.push(CLEAR_SCREEN);
    out.push(`${BOLD}${this.title}${RESET}`);
    out.push(`${DIM}${this.status} · ${this.chunkCount} chunk(s) received${RESET}`);
    out.push(DIM + "-".repeat(this.width) + RESET);

    for (const line of this.lines) {
      out.push(...renderLine(line, this.width, false));
    }
    if (this.pending) {
      out.push(...renderLine(this.pending, this.width, true));
    }

    out.push("");
    out.push(`${DIM}Ctrl-C to stop${RESET}`);
    process.stdout.write(`${out.join("\n")}\n`);
  }
}

function renderLine(line, width, interim) {
  if (line.speaker === null) {
    return [`${DIM}[${line.clock}] ${line.text}${RESET}`];
  }
  const head = `[${line.clock}] ${BOLD}${line.speaker}${RESET}${interim ? ` ${DIM}...${RESET}` : ""}`;
  const body = wrap(line.text, width - 4).map((part) => `    ${interim ? DIM + part + RESET : part}`);
  return [head, ...body];
}

function formatPlain(line) {
  if (line.speaker === null) return `[${line.clock}] ${line.text}`;
  return `[${line.clock}] ${line.speaker}: ${line.text}`;
}

function wrap(text, width) {
  const lines = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if (current && current.length + word.length + 1 > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** ISO timestamp (or now) → HH:MM:SS. */
function formatClock(timestamp) {
  const date = timestamp ? new Date(timestamp) : new Date();
  const valid = Number.isFinite(date.getTime()) ? date : new Date();
  return valid.toTimeString().slice(0, 8);
}
