/**
 * Text to speech with what the operating system already has, so a typed
 * script can be played into a meeting by the speaker bot:
 *
 *   Windows  System.Speech (built in; via Windows PowerShell)
 *   macOS    `say` (built in)
 *   Linux    `espeak-ng` or `espeak`, if installed
 *
 * The script is also the exact reference transcript, so a run needs no
 * separate one. Synthetic speech is cleaner than people talking, so WER on it
 * reads lower than on real speech; METHODOLOGY.md says so.
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function onPath(cmd) {
  const probe = process.platform === "win32" ? spawnSync("where", [cmd]) : spawnSync("sh", ["-c", `command -v ${cmd}`]);
  return probe.status === 0;
}

/** Which engine this machine would use, or null. */
function ttsEngine() {
  if (process.platform === "win32") return { name: "Windows speech (System.Speech)", kind: "windows" };
  if (process.platform === "darwin") return { name: "macOS say", kind: "say" };
  for (const cmd of ["espeak-ng", "espeak"]) if (onPath(cmd)) return { name: cmd, kind: "espeak", cmd };
  return null;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}: ${err.trim()}`))));
  });
}

/**
 * Speaks `text` into a WAV file in `dir` and returns its path. Always WAV, so
 * the desktop app's built-in decoder can read it without ffmpeg.
 */
async function synthesize(text, dir) {
  const engine = ttsEngine();
  if (!engine) throw new Error("No text-to-speech on this machine. On Linux install espeak-ng (e.g. sudo apt install espeak-ng), or play an audio file instead.");
  if (!text?.trim()) throw new Error("The script is empty.");
  fs.mkdirSync(dir, { recursive: true });
  // The text goes through a file, never the command line.
  const textFile = path.join(dir, "script.txt");
  fs.writeFileSync(textFile, text, "utf8");

  if (engine.kind === "windows") {
    const out = path.join(dir, "speech.wav");
    const q = (p) => `'${p.replace(/'/g, "''")}'`;
    const script = [
      "Add-Type -AssemblyName System.Speech",
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      `$s.SetOutputToWaveFile(${q(out)})`,
      `$s.Speak([IO.File]::ReadAllText(${q(textFile)}, [Text.Encoding]::UTF8))`,
      "$s.Dispose()",
    ].join("; ");
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
    return { file: out, engine: engine.name };
  }
  if (engine.kind === "say") {
    const out = path.join(dir, "speech.wav");
    await run("say", ["-f", textFile, "-o", out, "--file-format=WAVE", "--data-format=LEI16@22050"]);
    return { file: out, engine: engine.name };
  }
  const out = path.join(dir, "speech.wav");
  await run(engine.cmd, ["-f", textFile, "-w", out]);
  return { file: out, engine: engine.name };
}

module.exports = { ttsEngine, synthesize };
