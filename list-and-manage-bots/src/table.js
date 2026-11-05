/**
 * A tiny fixed-width table printer. No dependency, no colour codes, so the
 * output stays readable when piped into a file or a terminal without ANSI.
 */

function truncate(value, width) {
  const str = value === null || value === undefined ? "-" : String(value);
  if (str.length <= width) return str;
  return str.slice(0, Math.max(1, width - 1)) + "…";
}

/**
 * @param {Array<Array<string>>} rows  already-stringified cells
 * @param {Array<{title:string,width:number}>} columns
 */
export function printTable(columns, rows) {
  const header = columns.map((c) => c.title.padEnd(c.width)).join("  ");
  console.log(header);
  console.log(columns.map((c) => "-".repeat(c.width)).join("  "));

  for (const row of rows) {
    console.log(
      row.map((cell, i) => truncate(cell, columns[i].width).padEnd(columns[i].width)).join("  ")
    );
  }
}

export const BOT_COLUMNS = [
  { title: "BOT ID", width: 26 },
  { title: "STATUS", width: 14 },
  { title: "NAME", width: 20 },
  { title: "WHEN", width: 20 },
  { title: "MEETING", width: 34 },
];

export function botRow(bot) {
  const when = bot.createdAt ?? bot.joinAt;
  return [
    bot.id,
    bot.status,
    bot.name ?? "-",
    when ? formatWhen(when) : "-",
    bot.meeting ?? "-",
  ];
}

function formatWhen(value) {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return String(value);
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}
