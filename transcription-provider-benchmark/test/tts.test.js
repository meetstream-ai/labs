const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ttsEngine, synthesize } = require("../src/tts");
const { decodeToPcm } = require("../src/audio");

test("a typed script becomes speech the recorder can play", { skip: !ttsEngine() && "no text-to-speech on this machine" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-"));
  try {
    const text = "Mister Quilter is the apostle of the middle classes.";
    const { file, engine } = await synthesize(text, dir);
    assert.ok(engine);
    assert.equal(fs.readFileSync(path.join(dir, "script.txt"), "utf8"), text); // doubles as the reference
    const seconds = (await decodeToPcm(file, 16000)).length / 2 / 16000;
    assert.ok(seconds > 1 && seconds < 20, `${seconds}s of speech`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty script is refused", { skip: !ttsEngine() && "no text-to-speech on this machine" }, async () => {
  await assert.rejects(synthesize("   ", fs.mkdtempSync(path.join(os.tmpdir(), "tts-"))), /script is empty/);
});
