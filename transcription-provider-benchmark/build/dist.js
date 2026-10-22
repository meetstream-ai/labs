/**
 * `npm run dist*`: electron-builder, plus one convenience.
 *
 * electron-builder reads the folder it caches downloaded Electron zips in from
 * its config (electronDownload.cache), not from the environment. If you keep
 * that cache somewhere specific (e.g. off your system drive) by setting
 * ELECTRON_CACHE, this passes it through, so the choice stays on your machine
 * and out of package.json. Its own tool cache already follows
 * ELECTRON_BUILDER_CACHE.
 *
 * It also stamps the git commit into build-info.json, which the app records
 * in every run (a packaged app has no .git to ask).
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { harnessInfo } = require("../src/version");

const info = harnessInfo();
fs.writeFileSync(path.join(__dirname, "..", "build-info.json"),
  JSON.stringify({ commit: info.commit, dirty: info.dirty, built_at: new Date().toISOString() }, null, 2) + "\n");

// The app ships the sample clip (it can't build it: that needs ffmpeg, which
// the desktop build leaves out). Build it here first if this checkout hasn't.
if (!fs.existsSync(path.join(__dirname, "..", "sample", "clip.wav"))) {
  const built = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "fetch-sample.js")], { stdio: "inherit" });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

const args = process.argv.slice(2);
if (process.env.ELECTRON_CACHE) args.push(`--config.electronDownload.cache=${process.env.ELECTRON_CACHE}`);

const result = spawnSync(process.execPath, [require.resolve("electron-builder/cli.js"), ...args], { stdio: "inherit" });
process.exit(result.status ?? 1);
