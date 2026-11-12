require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { parseArgs } = require("util");
const { selectProviders } = require("./src/providers");

const USAGE = `
  npm run fetch-sample                     build sample/clip.wav + sample/reference.txt
  npm run record    [-- --audio F --reference F | --script text.txt] [--no-reference]
                                           two bots join MEETING_LINK; one plays the clip, one records it
  npm run record    -- --listener-only [--bot-name N --reference F --max-minutes M]
                                           one bot records whatever people say or play in the call
  npm run benchmark [-- --bot-id ID --reference F --providers a,b --rounds N --poll S] [--no-reference]
                                           run that one recording through every provider, then score it

  The reference is what was actually said. The sample clip and a --script bring
  their own; your own --audio needs --reference. A recording remembers its
  reference, so benchmark uses it unless you pass another or --no-reference.
  npm run score     -- results/<run>       re-score a finished run offline (no API key needed)
  npm run score     -- results/<run> --reference F
                                           add what was said to a run that had no reference, then score it
  npm run fetch-raw -- results/<run>       add providers' raw responses to an older run (for cost), then re-score
  npm run ui                               the same tool in your browser
`;

function latestRecording() {
  if (!fs.existsSync("recordings")) return null;
  const files = fs.readdirSync("recordings").filter((f) => f.endsWith(".json"));
  if (!files.length) return null;
  files.sort((a, b) => fs.statSync(path.join("recordings", b)).mtimeMs - fs.statSync(path.join("recordings", a)).mtimeMs);
  return JSON.parse(fs.readFileSync(path.join("recordings", files[0]), "utf8")).bot_id;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      audio: { type: "string" },
      reference: { type: "string" },
      "no-reference": { type: "boolean", default: false },
      "bot-id": { type: "string" },
      append: { type: "string" },
      "live-provider": { type: "string" },
      "listener-only": { type: "boolean", default: false },
      script: { type: "string" },
      "bot-name": { type: "string" },
      "max-minutes": { type: "string", default: "30" },
      providers: { type: "string" },
      rounds: { type: "string", default: "1" },
      // Turnaround is only known to one poll interval, so poll often: 1 s
      // (5 s before 2026-09-30, which made most providers indistinguishable).
      poll: { type: "string", default: "1" },
      timeout: { type: "string", default: "30" },
    },
  });
  const [command, target] = positionals;

  switch (command) {
    case "record": {
      if (!process.env.MEETING_LINK) throw new Error("MEETING_LINK is not set in your .env file.");
      if (values.reference && values["no-reference"]) throw new Error("Pass --reference or --no-reference, not both.");
      if (values["listener-only"]) {
        const { recordListenerOnly } = require("./src/recorder");
        await recordListenerOnly({
          meetingLink: process.env.MEETING_LINK,
          botName: values["bot-name"] ?? "Benchmark Recorder",
          referencePath: values.reference,
          maxMinutes: parseFloat(values["max-minutes"]),
        });
        break;
      }
      if (values.script && values.audio) throw new Error("Pass --audio or --script, not both.");
      // The reference defaults to what the audio came with: the sample clip's
      // transcript, or a --script's own text. Your own --audio has none unless
      // you pass --reference; it is never scored against the sample's.
      let audioPath = values.audio ?? "sample/clip.wav";
      let referencePath = values.reference ?? (values.audio ? null : "sample/reference.txt");
      let synthetic = null;
      if (values.script) {
        const { synthesize } = require("./src/tts");
        const text = fs.readFileSync(values.script, "utf8");
        const dir = path.join("uploads", `script-${new Date().toISOString().replace(/[:.]/g, "-")}`);
        const speech = await synthesize(text, dir);
        console.log(`  Spoke the script with ${speech.engine} -> ${speech.file}`);
        audioPath = speech.file;
        referencePath = values.reference ?? path.join(dir, "script.txt");
        synthetic = speech.engine;
      }
      if (values["no-reference"]) referencePath = null;
      if (!fs.existsSync(audioPath)) throw new Error(`${audioPath} not found. Run \`npm run fetch-sample\` first.`);
      if (referencePath && !fs.existsSync(referencePath)) throw new Error(`${referencePath} not found. Run \`npm run fetch-sample\` first.`);
      const { record } = require("./src/recorder");
      await record({
        meetingLink: process.env.MEETING_LINK,
        audioPath,
        referencePath,
        synthetic,
        liveProvider: values["live-provider"] ? selectProviders(values["live-provider"])[0] : undefined,
        port: parseInt(process.env.PORT || "3000", 10),
      });
      break;
    }
    case "benchmark": {
      const providers = selectProviders(values.providers);
      const botId = values["bot-id"] ?? latestRecording();
      if (!botId) throw new Error("No recording yet. Run `npm run record`, or pass --bot-id for an existing bot.");
      const { benchmark } = require("./src/benchmark");
      if (values.reference && values["no-reference"]) throw new Error("Pass --reference or --no-reference, not both.");
      await benchmark({
        botId,
        referencePath: values.reference,
        noReference: values["no-reference"],
        providers,
        rounds: parseInt(values.rounds, 10),
        pollSeconds: parseFloat(values.poll),
        timeoutMinutes: parseFloat(values.timeout),
        appendTo: values.append,
      });
      break;
    }
    case "fetch-raw": {
      if (!target) throw new Error("Usage: npm run fetch-raw -- results/<run>");
      const api = require("./src/api");
      const runPath = path.join(target, "run.json");
      const run = JSON.parse(fs.readFileSync(runPath, "utf8"));
      for (const job of run.jobs.filter((j) => j.status === "Success" && j.transcript_file && !j.raw_file)) {
        try {
          const raw = await api.getTranscript(job.transcript_id, { raw: true });
          job.raw_file = job.transcript_file.replace(/\.json$/, ".raw.json");
          fs.writeFileSync(path.join(target, job.raw_file), JSON.stringify(raw, null, 2));
          console.log(`  ${job.provider.padEnd(12)} saved ${job.raw_file}`);
        } catch (err) {
          console.log(`  ${job.provider.padEnd(12)} ${api.describeError(err)}`);
        }
      }
      fs.writeFileSync(runPath, JSON.stringify(run, null, 2) + "\n");
      const { score } = require("./src/report");
      console.log(score(target).markdown);
      break;
    }
    case "score": {
      if (!target) throw new Error("Usage: npm run score -- results/<run> [--reference F]");
      const { score, addReference } = require("./src/report");
      // --reference on a run that had none: add what was said, then score it.
      console.log((values.reference ? addReference(target, values.reference) : score(target)).markdown);
      break;
    }
    default:
      console.log(USAGE);
  }
}

main().then(
  // The ngrok tunnel keeps the event loop alive after a recording.
  () => process.exit(0),
  (err) => {
    // An API error: show MeetStream's own reason (e.g. "Zoom bots require
    // Zoom credentials in user profile"), not just "status code 400".
    const why = err.response ? require("./src/api").describeError(err) : err.message;
    console.error(`\n  ${why}\n`);
    process.exit(1);
  }
);
