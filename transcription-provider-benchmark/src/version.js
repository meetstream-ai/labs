/**
 * Which harness produced a run, so a result can be traced to the exact code:
 * the package version, and the git commit (with whether there were
 * uncommitted changes). A packaged desktop app has no .git, so `npm run dist`
 * stamps the commit into build-info.json instead.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function git(args) {
  const r = spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

function harnessInfo() {
  const { name, version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const commit = git(["rev-parse", "HEAD"]);
  if (commit) {
    // Uncommitted changes to the harness itself (runs and uploads don't count).
    const dirty = (git(["status", "--porcelain", "--", ".", ":!results", ":!recordings", ":!uploads", ":!sample"]) ?? "") !== "";
    return { name, version, commit, dirty, from: "git" };
  }
  try {
    const built = JSON.parse(fs.readFileSync(path.join(ROOT, "build-info.json"), "utf8"));
    return { name, version, commit: built.commit ?? null, dirty: built.dirty ?? null, from: "build" };
  } catch {
    return { name, version, commit: null, dirty: null, from: null };
  }
}

module.exports = { harnessInfo };
