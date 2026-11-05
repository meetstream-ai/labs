/**
 * Interactive prompt for driving the control channel by hand.
 *
 * Every command here maps onto exactly one control-channel command, so the
 * transcript of a session doubles as documentation of the protocol.
 */

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

import { log, c } from "./logger.js";
import { loadPcm } from "./pcm.js";

export const HELP = `
Commands
  msg <text>          sendmsg      chat message (sets both message and msg)
  chat <text>         sendchat     chat message with role=assistant, is_final=true
  stream <text>       sendchat     same, streamed as interim frames then a final one
  audio <path>        sendaudio    play a .wav (PCM16/48k/mono) or .pcm file through the mic
  interrupt           interrupt    clear the bot's audio queue (Google Meet only)
  imgurl <url>        sendimg_url  set the bot's camera feed to a public image URL
  img <path>          sendimg      set the bot's camera feed to a local image (base64)
  status                           show connection state
  help                             this list
  quit                             remove the bot and exit
`;

/**
 * @param {import("./control-channel.js").ControlChannel} channel
 * @param {{ onQuit: () => Promise<void>|void }} hooks
 */
export function startRepl(channel, { onQuit }) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: c("cyan", "control> "),
  });

  console.log(HELP);
  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (input === "") {
      rl.prompt();
      return;
    }

    const space = input.indexOf(" ");
    const command = (space === -1 ? input : input.slice(0, space)).toLowerCase();
    const rest = space === -1 ? "" : input.slice(space + 1).trim();

    try {
      await run(channel, command, rest, rl, onQuit);
    } catch (err) {
      log.error(err.message);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    void onQuit();
  });

  return rl;
}

async function run(channel, command, rest, rl, onQuit) {
  switch (command) {
    case "help":
    case "?":
      console.log(HELP);
      return;

    case "status":
      log.info(
        `connected=${channel.connected} bot_id=${channel.botId ?? "-"} ` +
        `audio_playing=${channel.audioPlaying}`
      );
      return;

    case "msg":
      requireText(rest, "msg <text>");
      channel.sendMsg(rest);
      log.success(`sendmsg → "${rest}"`);
      return;

    case "chat":
      requireText(rest, "chat <text>");
      channel.sendChat(rest);
      log.success(`sendchat (final) → "${rest}"`);
      return;

    case "stream":
      requireText(rest, "stream <text>");
      log.info("Streaming interim sendchat frames…");
      await channel.streamChat(rest);
      log.success(`sendchat streamed and committed → "${rest}"`);
      return;

    case "interrupt":
      channel.interrupt();
      log.success("interrupt sent (clear_audio_queue): Google Meet clears, Zoom and Teams do not");
      return;

    case "imgurl":
      requireText(rest, "imgurl <url>");
      channel.sendImgUrl(rest);
      log.success(`sendimg_url → ${rest}`);
      return;

    case "img": {
      requireText(rest, "img <path>");
      const bytes = readFileSync(rest);
      channel.sendImgBase64(bytes.toString("base64"));
      log.success(`sendimg → ${rest} (${(bytes.length / 1024).toFixed(1)} KB)`);
      return;
    }

    case "audio": {
      requireText(rest, "audio <path>");
      const { pcm, seconds, source } = loadPcm(rest);
      log.info(`Loaded ${rest} (${source}, ${seconds.toFixed(1)}s of PCM16/48k/mono)`);
      log.detail("Streaming: type interrupt in another line to stop it early.");
      const result = await channel.sendAudio(pcm);
      log.success(
        `sendaudio finished: ${result.chunks} chunks, ${result.seconds.toFixed(1)}s` +
        (result.cancelled ? " (cancelled early)" : "")
      );
      return;
    }

    case "quit":
    case "exit":
      rl.close();
      await onQuit();
      return;

    default:
      log.warn(`Unknown command "${command}". Type help.`);
  }
}

function requireText(value, usage) {
  if (!value) throw new Error(`Usage: ${usage}`);
}
