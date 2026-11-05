/**
 * Terminal formatting helpers - plain strings, no dependencies.
 */

/** Format seconds as `1h 02m 03s` / `2m 03s` / `3.4s`. */
export function duration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return 'n/a';
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/** Format a 0..1 fraction as a percentage string. */
export function percent(fraction, digits = 1) {
  if (!Number.isFinite(fraction)) return 'n/a';
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Human-readable byte count. */
export function bytes(n) {
  if (!Number.isFinite(n)) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** A solid/light block bar representing a 0..1 fraction. */
export function bar(fraction, width = 30) {
  if (!Number.isFinite(fraction) || fraction <= 0) return '·'.repeat(width);
  const filled = Math.min(width, Math.max(1, Math.round(fraction * width)));
  return '█'.repeat(filled) + '·'.repeat(width - filled);
}

/**
 * Render an aligned text table.
 *
 * @param {string[]} headers
 * @param {Array<Array<string|number>>} rows
 * @param {{ align?: Array<'left'|'right'> }} [opts]
 */
export function table(headers, rows, { align = [] } = {}) {
  const all = [headers, ...rows].map((r) => r.map((c) => String(c ?? '')));
  const widths = headers.map((_, i) => Math.max(...all.map((r) => visibleLength(r[i] ?? ''))));
  const line = (cells) =>
    cells
      .map((cell, i) => (align[i] === 'right' ? padStart(cell, widths[i]) : padEnd(cell, widths[i])))
      .join('  ')
      .trimEnd();
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(all[0]), sep, ...all.slice(1).map(line)].join('\n');
}

// Block characters count as width 1 in a monospace terminal, so a plain
// length check is fine here; this indirection just keeps padding logic in
// one place.
function visibleLength(s) {
  return [...s].length;
}

function padEnd(s, width) {
  return s + ' '.repeat(Math.max(0, width - visibleLength(s)));
}

function padStart(s, width) {
  return ' '.repeat(Math.max(0, width - visibleLength(s))) + s;
}

/** A section heading with an underline. */
export function heading(text) {
  return `\n${text}\n${'='.repeat(text.length)}`;
}

/** Wrap text to a column width, preserving existing newlines. */
export function wrap(text, width = 78, indent = '') {
  return String(text)
    .split('\n')
    .flatMap((paragraph) => {
      if (!paragraph.trim()) return [''];
      const words = paragraph.split(/\s+/);
      const lines = [];
      let current = '';
      for (const word of words) {
        if (!current) current = word;
        else if (current.length + 1 + word.length <= width) current += ` ${word}`;
        else {
          lines.push(current);
          current = word;
        }
      }
      if (current) lines.push(current);
      return lines;
    })
    .map((l) => (l ? indent + l : ''))
    .join('\n');
}

/** Turn `camelCase` / `snake_case` / `PascalCase` into `Title Case`. */
export function titleize(key) {
  return String(key)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Best-effort ISO -> readable local timestamp. Returns the input if unparseable. */
export function timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}
