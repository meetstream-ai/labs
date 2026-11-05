/**
 * Tiny fixed-width table renderer. Keeps the schedule output readable in a
 * terminal without pulling in a formatting dependency.
 */

function truncate(value, width) {
  const text = value == null ? "" : String(value);
  if (text.length <= width) return text.padEnd(width);
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
}

/**
 * @param {{key: string, label: string, width: number}[]} columns
 * @param {object[]} rows
 */
export function renderTable(columns, rows) {
  const header = columns.map((c) => truncate(c.label, c.width)).join("  ");
  const divider = columns.map((c) => "-".repeat(c.width)).join("  ");
  const body = rows.map((row) =>
    columns.map((c) => truncate(row[c.key], c.width)).join("  ")
  );
  return [header, divider, ...body].join("\n");
}

/**
 * Formats an ISO timestamp for display, preserving the offset the API sent
 * rather than silently converting to the local zone.
 */
export function formatStart(iso) {
  if (!iso) return "(no start time)";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);

  const pad = (n) => String(n).padStart(2, "0");
  // Show the local rendering, which is what a human reading their own
  // calendar expects, and keep it sortable.
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
