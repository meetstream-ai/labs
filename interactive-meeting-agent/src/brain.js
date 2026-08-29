/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THIS FILE IS THE STUB. IT IS THE ONE PART OF THIS TEMPLATE THAT IS FAKE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything else in this template is real MeetStream plumbing: the live audio
 * frame parser, the turn detection, the control channel, the command payloads,
 * the bot lifecycle. What happens *between* hearing something and responding is
 * deliberately a placeholder (a keyword matcher), so the wiring is easy to read
 * and you can drop your own model in without unpicking anything else.
 *
 * ── The contract ────────────────────────────────────────────────────────────
 *
 * A brain exposes two async methods. Both return an array of actions, which may
 * be empty. The runtime executes them in order:
 *
 *   { type: "chat",      text }             -> sendchat, committed in one frame
 *   { type: "chat",      text, stream: true } -> sendchat, streamed then committed
 *   { type: "msg",       text }             -> sendmsg (plain chat message)
 *   { type: "say",       file }             -> sendaudio from a PCM16/48k/mono file
 *   { type: "interrupt" }                   -> clear the bot's audio queue
 *
 * ── Replacing it with a real LLM ─────────────────────────────────────────────
 *
 * Swap the body of onTranscript for a model call. Sketch, using the Anthropic SDK
 * (`npm install @anthropic-ai/sdk`):
 *
 *   import Anthropic from "@anthropic-ai/sdk";
 *   const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
 *
 *   async onTranscript({ speaker, text, isFinal }) {
 *     if (!isFinal) return [];
 *     history.push({ role: "user", content: `${speaker}: ${text}` });
 *
 *     const reply = await anthropic.messages.create({
 *       model: "claude-sonnet-4-5",
 *       max_tokens: 300,
 *       system: "You are a meeting assistant. Answer in one or two sentences.",
 *       messages: history,
 *     });
 *
 *     const answer = reply.content.find((b) => b.type === "text")?.text ?? "";
 *     history.push({ role: "assistant", content: answer });
 *     return answer ? [{ type: "chat", text: answer, stream: true }] : [];
 *   }
 *
 * To answer with speech rather than text, run the model output through a TTS
 * service, write the result as raw PCM16 LE / 48000 Hz / mono, and return
 * { type: "say", file: "<path>" }. The sendaudio chunking and pacing is already
 * handled in src/control-channel.js.
 *
 * Keep responses short and keep the model call fast. Anything past roughly two
 * seconds and the meeting has moved on by the time the bot speaks.
 */

const RECAP_WORDS = ["recap", "summary", "summarise", "summarize", "catch me up"];

export function createBrain({ wakeWord = "hey bot", responseAudioFile = null, logger } = {}) {
  const wake = wakeWord.toLowerCase();

  // A real brain would keep conversation history here and pass it to the model.
  const heard = [];

  return {
    /**
     * Called for every live transcript segment.
     * @param {{ speaker: string, text: string, isFinal: boolean }} input
     */
    async onTranscript({ speaker, text, isFinal }) {
      if (!isFinal) return []; // wait for a committed segment before reacting

      const clean = text.trim();
      if (!clean) return [];

      heard.push({ speaker, text: clean });

      const lower = clean.toLowerCase();
      if (!lower.includes(wake)) return [];

      logger?.info(`Wake word matched in: "${clean}"`);

      const question = clean.slice(lower.indexOf(wake) + wake.length).replace(/^[\s,.:!?-]+/, "");
      const actions = [];

      if (RECAP_WORDS.some((word) => lower.includes(word))) {
        const lines = heard.slice(-6).map((h) => `${h.speaker}: ${h.text}`);
        actions.push({
          type: "chat",
          text: `Last few things said:\n${lines.join("\n")}`,
          stream: true,
        });
      } else if (question) {
        // ── PLUG YOUR LLM IN HERE ──────────────────────────────────────────
        // This canned acknowledgement exists so the plumbing is demonstrably
        // working end to end. Replace it with a model call.
        actions.push({
          type: "chat",
          text: `${speaker}, I heard: "${question}". This template ships with a stub brain: wire an LLM into src/brain.js to answer properly.`,
          stream: true,
        });
      } else {
        actions.push({ type: "chat", text: `Yes ${speaker}?` });
      }

      // Speaking is optional and only happens if you supplied real audio.
      if (responseAudioFile) {
        actions.push({ type: "interrupt" });
        actions.push({ type: "say", file: responseAudioFile });
      }

      return actions;
    },

    /**
     * Called when energy-based turn detection sees somebody finish speaking.
     * Useful for reacting to speech patterns rather than words: long monologues,
     * dead air, who is dominating the call.
     *
     * @param {{ speaker: string, seconds: number, peakRms: number }} input
     */
    async onUtterance({ speaker, seconds }) {
      logger?.detail(`${speaker} spoke for ${seconds.toFixed(1)}s`);
      return [];
    },
  };
}
