const test = require("node:test");
const assert = require("node:assert/strict");
const { textSha256 } = require("../src/audio");

test("a reference hashes the same with Windows (CRLF) and macOS/Linux (LF) line endings", () => {
  const lf = "MISTER QUILTER IS THE APOSTLE\nOF THE MIDDLE CLASSES\n";
  assert.equal(textSha256(lf.replace(/\n/g, "\r\n"), { isText: true }), textSha256(lf, { isText: true }));
  assert.notEqual(textSha256("a b\n", { isText: true }), textSha256("a c\n", { isText: true }));
});
