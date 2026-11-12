/**
 * Desktop app: the benchmark UI in its own window, no terminal or Node needed.
 *
 * Electron's main process runs the same local server as `npm run ui`
 * (server.js) on a free port bound to 127.0.0.1, and a window shows its page.
 * Runs still go through `index.js`, started with Electron's bundled Node.
 *
 * Data (runs, recordings, the sample clip, uploads) lives in the app's user
 * data folder by default, since an installed app cannot write next to its own
 * files:
 *   Windows  %APPDATA%\Transcriber Benchmark
 *   macOS    ~/Library/Application Support/Transcriber Benchmark
 *   Linux    ~/.config/Transcriber Benchmark
 * API keys typed into the page are kept there too, encrypted with the OS key
 * store (Electron safeStorage), so they survive restarts.
 *
 * To keep all of it somewhere else (another drive, say), set the environment
 * variable TRANSCRIBER_BENCHMARK_DATA to a folder. Everything the app writes
 * goes there instead: runs and keys, and Chromium's own caches, logs and
 * crash dumps. It is independent of where the app is installed, so it
 * survives upgrades and reinstalls.
 */
const { app, BrowserWindow, Menu, shell, safeStorage, dialog } = require("electron");
const fs = require("fs");
const path = require("path");

const APP_ROOT = path.join(__dirname, "..");

// Must run before anything touches userData (the single-instance lock does).
const customData = process.env.TRANSCRIBER_BENCHMARK_DATA?.trim();
if (customData) {
  const dir = path.resolve(customData);
  fs.mkdirSync(dir, { recursive: true });
  app.setPath("userData", dir);
  app.setPath("sessionData", dir);
  app.setPath("logs", path.join(dir, "logs"));
  app.setPath("crashDumps", path.join(dir, "crashes"));
}

// One window per machine: a second launch focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(launch).catch((err) => {
    dialog.showErrorBox("Transcriber Benchmark could not start", String(err?.stack ?? err));
    app.quit();
  });
}

/** Keys encrypted at rest with the OS key store; plain memory if unavailable. */
function keyStore(dir) {
  const file = path.join(dir, "keys.bin");
  return {
    load() {
      try {
        if (!fs.existsSync(file) || !safeStorage.isEncryptionAvailable()) return {};
        return JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
      } catch { return {}; }
    },
    save(keys) {
      if (!safeStorage.isEncryptionAvailable()) return; // don't write keys in the clear
      fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(keys)), { mode: 0o600 });
    },
    persistent: () => safeStorage.isEncryptionAvailable(),
  };
}

/**
 * First launch: copy the example run bundled with the app (Test 1) and the
 * sample transcript into the data folder, so there is something to look at
 * and the sample reference is ready before the clip is downloaded.
 */
function seed(dataDir) {
  const copyDir = (from, to) => {
    if (!fs.existsSync(from) || fs.existsSync(to)) return;
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, entry.name), b = path.join(to, entry.name);
      if (entry.isDirectory()) copyDir(a, b);
      else fs.copyFileSync(a, b);
    }
  };
  const results = path.join(APP_ROOT, "results");
  if (fs.existsSync(results)) {
    for (const run of fs.readdirSync(results)) copyDir(path.join(results, run), path.join(dataDir, "results", run));
  }
  // The sample clip ships with the app (6 MB): building it needs ffmpeg to
  // decode LibriSpeech's FLAC, which the desktop build leaves out.
  for (const f of ["reference.txt", "manifest.json", "clip.wav"]) {
    const from = path.join(APP_ROOT, "sample", f), to = path.join(dataDir, "sample", f);
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

async function launch() {
  const dataDir = app.getPath("userData");
  fs.mkdirSync(dataDir, { recursive: true });
  seed(dataDir);
  process.env.BENCH_DATA_DIR = dataDir; // read by server.js when it loads

  const { start, shutdown } = require(path.join(APP_ROOT, "server.js"));
  const { port } = await start({ port: 0, store: keyStore(dataDir), openPath: (dir) => shell.openPath(dir) });
  // Closing mid-run: take the run's bots out of the meeting first, or they
  // stay in the call (and keep billing) until the recorder's time limit.
  let closing = false;
  app.on("before-quit", (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    shutdown().finally(() => app.quit());
  });
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Transcriber Benchmark serving ${url} (data: ${dataDir})`);

  // No menu bar: everything lives in the app (Settings has the data folder).
  // macOS keeps its standard app and Edit menus, which copy and paste need there.
  Menu.setApplicationMenu(process.platform === "darwin"
    ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }])
    : null);

  const win = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 380,
    minHeight: 560,
    title: "Transcriber Benchmark",
    backgroundColor: "#0E0E13",
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once("ready-to-show", () => win.show());

  // The page stays on the local server; anything else opens in the browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(url)) { event.preventDefault(); shell.openExternal(target); }
  });

  await win.loadURL(url);
}

app.on("window-all-closed", () => app.quit());
