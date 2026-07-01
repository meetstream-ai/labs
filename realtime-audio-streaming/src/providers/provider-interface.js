/**
 * Provider Interface
 * ─────────────────────────────────────────────────────────────────────────────
 * Every external application plugs in by exporting an object matching this
 * shape. The bridge (bridge.js) only ever talks to this interface — it has
 * no idea whether it's forwarding audio to Deepgram, AssemblyAI, a custom
 * in-house model, or just printing it to a file. Swapping providers means
 * writing one new file here and changing one line in .env. Nothing else
 * in the project needs to change.
 *
 * ── Required shape ────────────────────────────────────────────────────────
 *
 *   {
 *     name: "human readable name",
 *
 *     // Called once when the bridge starts. Open your connection, auth, etc.
 *     // `onResult(text, isFinal, meta)` — call this whenever you have output
 *     //   to surface (a transcript line, a detection, a score, anything).
 *     //   The bridge handles printing it; you just call the callback.
 *     async connect(onResult) {},
 *
 *     // Called for every audio frame received from /stream.
 *     // `pcm` is a raw Buffer: PCM16 little-endian, 48000 Hz, mono.
 *     // `speakerName` is the display name attached to that frame (may be
 *     //   "Unidentified Speaker" early in a call).
 *     sendAudio(pcm, speakerName) {},
 *
 *     // Called once when the bridge is shutting down (Ctrl+C, or upstream
 *     // /stream closed). Close sockets, flush buffers, clean up.
 *     async disconnect() {},
 *   }
 *
 * ── Minimal example ───────────────────────────────────────────────────────
 *
 *   export default {
 *     name: "My Custom App",
 *     async connect(onResult) {
 *       this.socket = new WebSocket("wss://my-app.example.com/ingest");
 *       this.socket.on("message", (msg) => onResult(msg.toString(), true));
 *     },
 *     sendAudio(pcm) {
 *       this.socket.send(pcm);
 *     },
 *     async disconnect() {
 *       this.socket?.close();
 *     },
 *   };
 *
 * See src/providers/deepgram.js for a complete real-world implementation,
 * and src/providers/console.js for the simplest possible one (no network).
 */

export const PROVIDER_INTERFACE_VERSION = 1;
