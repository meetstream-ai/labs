/**
 * `npm run report-pdf -- reports/<date>`: renders that report's REPORT.md to
 * REPORT.pdf (A4) with Electron's built-in Chromium, so the PDF always matches
 * the Markdown. Relative links become links to the files on GitHub, so they
 * still work in the PDF.
 *
 * Runs under Electron (it's the desktop app's dev dependency). Electron's
 * scratch data goes in reports/<date>/.pdf-profile (gitignored), not the
 * user's profile; it's cleared at the start of the next run.
 */
const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { marked } = require("marked");

const ROOT = path.join(__dirname, "..");
const dir = path.resolve(process.argv.find((a, i) => i > 1 && a.startsWith("reports")) ?? "");
if (!fs.existsSync(path.join(dir, "REPORT.md"))) {
  console.error("Usage: npm run report-pdf -- reports/<date>");
  process.exit(1);
}
// Where the published files live, for turning relative links into absolute ones.
const REPO_URL = process.env.REPORT_BASE_URL || "https://github.com/ThalhaAhamed/labs/blob/transcription-provider-benchmark/transcription-provider-benchmark/";
const base = new URL(path.relative(ROOT, dir).split(path.sep).join("/") + "/", REPO_URL);

const profile = path.join(dir, ".pdf-profile");
// Chromium holds its files until the process has exited, so the previous
// run's scratch folder is cleared here rather than at quit.
fs.rmSync(profile, { recursive: true, force: true });
app.setPath("userData", profile);
app.setPath("sessionData", profile);
app.setPath("crashDumps", path.join(profile, "crashes"));
app.disableHardwareAcceleration();

const md = fs.readFileSync(path.join(dir, "REPORT.md"), "utf8");
const title = md.match(/^# (.+)$/m)?.[1] ?? "Report";
let body = marked.parse(md);
body = body.replace(/href="(?!https?:|#|mailto:)([^"]+)"/g, (_, href) => `href="${new URL(href, base).href}"`);

const font = (f) => `url("${new URL("public/fonts/" + f, "file:///" + ROOT.split(path.sep).join("/") + "/").href}")`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>
@font-face { font-family: Geist; src: ${font("Geist-Variable.woff2")} format("woff2"); font-weight: 100 900; }
@font-face { font-family: "Geist Mono"; src: ${font("GeistMono-Variable.woff2")} format("woff2"); font-weight: 100 900; }
@page { size: A4; margin: 16mm 15mm 18mm; }
:root { --ink: #161514; --muted: #5f5b56; --line: #e3e0db; --accent: #c94a0e; --soft: #faf8f5; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font: 10pt/1.5 Geist, "Segoe UI", system-ui, sans-serif; color: var(--ink); margin: 0; }
h1 { font-size: 19pt; font-weight: 650; letter-spacing: -0.02em; margin: 0 0 8pt; padding-bottom: 8pt; border-bottom: 2.5pt solid var(--accent); }
h2 { font-size: 13pt; font-weight: 650; margin: 18pt 0 6pt; break-after: avoid; }
h3 { font-size: 11pt; font-weight: 600; margin: 13pt 0 5pt; break-after: avoid; }
p, li { margin: 0 0 6pt; }
ol, ul { padding-left: 15pt; margin: 0 0 8pt; }
a { color: var(--accent); text-decoration: none; }
strong { font-weight: 640; }
code { font: 8.6pt "Geist Mono", Consolas, monospace; background: var(--soft); border: 0.5pt solid var(--line); border-radius: 2pt; padding: 0 2pt; }
table { width: 100%; border-collapse: collapse; margin: 4pt 0 10pt; font-size: 8.8pt; break-inside: avoid; }
th { text-align: left; font-weight: 600; color: var(--muted); border-bottom: 1pt solid var(--ink); padding: 4pt 5pt; }
td { border-bottom: 0.5pt solid var(--line); padding: 3.5pt 5pt; font-variant-numeric: tabular-nums; vertical-align: top; }
td:first-child { white-space: nowrap; }
th[align="right"], td[align="right"] { text-align: right; }
tr:nth-child(even) td { background: var(--soft); }
blockquote { margin: 0 0 8pt; padding: 4pt 10pt; border-left: 2pt solid var(--accent); color: var(--muted); }
</style></head><body>${body}</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
  const pdf = await win.webContents.printToPDF({
    pageSize: "A4",
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: "<span></span>",
    footerTemplate: `<div style="font: 7pt Geist, sans-serif; color: #8a857f; width: 100%; padding: 0 15mm; display: flex; justify-content: space-between;"><span>${title.replace(/</g, "&lt;")}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    margins: { top: 0.6, bottom: 0.7, left: 0.55, right: 0.55 },
  });
  const out = path.join(dir, "REPORT.pdf");
  fs.writeFileSync(out, pdf);
  console.log(`${path.relative(ROOT, out)} (${(pdf.length / 1024).toFixed(0)} KB)`);
  app.quit();
}).catch((err) => { console.error(err); app.exit(1); });

