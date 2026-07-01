/**
 * Console provider — no external app, no network, no API key.
 * ─────────────────────────────────────────────────────────────────────────────
 * Just proves the pipeline is delivering audio at all: prints a byte counter
 * for every frame received. Useful as a zero-dependency sanity check before
 * wiring up a real third-party service, or as a template for the absolute
 * minimum a provider needs to implement.
 */

export default {
  name: "Console (debug — no external service)",

  bytesSeen: 0,
  framesSeen: 0,

  async connect(onResult) {
    this._onResult = onResult;
  },

  sendAudio(pcm, speakerName) {
    this.bytesSeen += pcm.length;
    this.framesSeen++;

    if (this.framesSeen % 40 === 0) {
      const kb = (this.bytesSeen / 1024).toFixed(1);
      this._onResult(
        `[${speakerName || "unknown"}] ${kb} KB received so far (${this.framesSeen} frames)`,
        true
      );
    }
  },

  async disconnect() {
    /* nothing to close */
  },
};
