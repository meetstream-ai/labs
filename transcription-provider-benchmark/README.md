# Transcription Provider Benchmark

This harness runs **one meeting recording through every transcription provider MeetStream supports** and outputs a table of word error rate and turnaround time.

No benchmark results are published here: run it on your own audio. Run output goes to `results/`, which is gitignored because it holds bot IDs, transcript IDs and whatever was said in the meeting.

**Read [METHODOLOGY.md](METHODOLOGY.md) before trusting any number this produces.** It covers what is measured and what is not, how each provider is configured, and how to check a result with a scorer MeetStream did not write.

## Scope

This harness compares MeetStream's **post-call** providers: the ones you configure on the dashboard's Integrations page, run on a finished recording. It doesn't measure live (streaming) transcription.

## How it works

```
 fetch-sample           record                              benchmark                          score
 ────────────           ──────                              ─────────                          ─────
 LibriSpeech  ──►  clip.wav ──► speaker bot ──► meeting ──► listener bot's recording ──┬─► meetstream  ─┐
 (pinned,          reference.txt   (sendaudio)                                          ├─► deepgram    ─┤
  CC BY 4.0)                                                                            ├─► assemblyai  ─┼─► WER + turnaround
                                                                                        ├─► sarvam      ─┤    per provider
                                                                                        └─► jigsawstack ─┘
                                              POST /bots/{id}/transcribe, same audio every time
```

1. **Record once.** A speaker bot plays the reference clip into a real meeting while a listener bot records it. The audio goes through the platform's real codec, like a customer's call would.
2. **Transcribe many times.** `POST /bots/{id}/transcribe` re-runs that one recording through each provider. Every provider gets byte-identical audio, and all are submitted together so they run under the same load.
3. **Score offline.** Each transcript is normalised and aligned against the reference. Everything needed to recompute the table, including the raw API responses, is saved in `results/<run>/`, so someone without an API key can check it.

## What you need

- Node.js 18+
- A MeetStream API key from [app.meetstream.ai](https://app.meetstream.ai)
- A free ngrok authtoken from [dashboard.ngrok.com](https://dashboard.ngrok.com/get-started/your-authtoken). The speaker bot connects back to this machine through it.
- A meeting link (Google Meet, Zoom or Teams) you can admit two bots into
- Each provider connected in your MeetStream account (see the next section)

## Before your first run: connect the providers

MeetStream runs every provider for you, so their keys go in your MeetStream account, not in this tool. Do this once:

1. Open the [MeetStream dashboard](https://app.meetstream.ai).
2. Go to **Integrations → Transcription**.
3. Connect **Deepgram**, **AssemblyAI**, **Sarvam** and **JigsawStack**, each with your own key for that provider.
4. **MeetStream transcription** (`meetstream`) is MeetStream's own engine and needs nothing.

A provider you haven't connected still appears in the results, marked "not run" with the API's reason. To leave it out, untick it in the app or pass `--providers`. The app's New benchmark page shows these steps too.

## Run it in your browser

```bash
npm install
npm run ui
```

Then open http://localhost:4173. After [connecting the providers](#before-your-first-run-connect-the-providers), the page walks through the same steps as the command line:

1. **Pick where the audio comes from:** a bot's existing recording, a meeting where a bot plays a clip (the sample, text you type for it to say, or your own file), or a meeting where people just talk.
2. **Say what was actually said.** Only the options that fit the audio are offered:
   - the sample clip → its transcript;
   - a typed script → the script;
   - your own audio, or people talking → your own transcript (pasted or loaded from a file);
   - an existing recording → the reference saved with it, if this app made it (a bot's recording is only audio, so for any other bot you paste your own transcript).

   Or pick none, which gives turnaround and cost only.
3. **Tick the providers,** then run.

While the run goes, the page shows each step and the full log. When it finishes you get:
- a table of accuracy, turnaround and cost, with the best value in each column highlighted;
- every word each provider got wrong, and its full transcript;
- every past run in the sidebar, with `results.md` and `results.json` to download;
- for a run without a reference (people talking, where you only know what was said afterwards), an **Add what was said** box. Paste the transcript and the run is scored for accuracy, marked as scored after the fact.

About the app itself:
- **It uses the command-line tool underneath.** Each run starts `node index.js record` / `benchmark` in the background, so a result from the page is the same as one from the terminal and lands in the same `results/` folder.
- **It stays on your machine.** It only listens on `127.0.0.1`, because it holds your MeetStream key and can send bots into your meetings.
- **Keys:** it reads them from `.env`, or you can paste them into the page, where they're kept in memory only.
- **The port** is set with `UI_PORT` (default 4173).

## Run it from the command line

```bash
npm install
cp .env.example .env
npm run fetch-sample
npm run record
npm run benchmark
```

Before this, [connect the providers](#before-your-first-run-connect-the-providers) in your MeetStream account. After copying `.env.example`, fill in `MEETSTREAM_API_KEY`, `MEETING_LINK` and `NGROK_AUTHTOKEN`.

What each step does:

- **`fetch-sample`** builds the ~3 min reference clip and its transcript (about 10 MB download, once).
- **`record`** starts the meeting yourself and admits both bots if asked. Keep everyone else muted: anything else said in the call counts as an insertion error for every provider. Both bots leave on their own when the clip ends.
- **`benchmark`** waits for the recording to finish processing, then runs every provider once on that recording. MeetStream allows each provider only one run per recording, so to get more samples you record again.

The table is printed and saved to `results/<run>/results.md`.

### Options

```bash
npm run benchmark -- --bot-id <id>            # any bot, not just the last one recorded
npm run benchmark -- --providers meetstream,deepgram
npm run benchmark -- --poll 0.5               # finer turnaround windows (default 1 s)
npm run benchmark -- --reference my-ref.txt   # verbatim transcript of what was said
npm run benchmark -- --no-reference           # turnaround and cost only, even if the recording saved a reference
npm run record -- --audio call.m4a --reference call.txt   # your own audio (any format ffmpeg reads); without --reference it isn't scored
npm run record -- --script what-to-say.txt   # the speaker bot reads your text aloud; the text is the reference
npm run record -- --live-provider assemblyai  # fallback: transcribe live with a provider the re-transcribe endpoint refuses
npm run benchmark -- --bot-id <id> --providers jigsawstack --append results/<run>   # re-run one provider into an existing run
npm run score -- results/<run>                # re-score a finished run, no API key needed
npm run score -- results/<run> --reference said.txt   # add what was said to a run that had no reference, then score it
npm run fetch-raw -- results/<run>            # add providers' raw responses to an older run (needed for cost)
npm run record -- --listener-only --bot-name "My Recorder"   # one bot records people talking; no speaker bot
```

Your own audio is the better test for a buying decision: your accents, your jargon, your crosstalk. The reference must be a verbatim transcript of what was said, not a summary or a cleaned-up version.

### Check the scorer independently

```bash
pip install -r scripts/requirements.txt
python scripts/score_jiwer.py results/<run>
```

This re-scores the same raw transcripts with jiwer and OpenAI Whisper's text normaliser. It shares no code with the Node scorer.

## Output

```
results/<run>/
  run.json                    bot, recording, exact provider configs, every job with timings
  reference.txt               the reference used
  transcripts/<p>.r<n>.json   raw get_transcript response per provider per round
  transcripts/<p>.r<n>.normalized.txt
  results.json                per-provider WER, S/D/I, turnaround, every word error
  results.md                  the table, plus each provider's errors listed word by word
```

## Files

| File | What it does |
|---|---|
| `index.js` | CLI: `record`, `benchmark` and `score` |
| `src/providers.js` | The exact config sent to each provider. Edit here, nowhere else. |
| `src/recorder.js` | Two bots, one control WebSocket, and real-time-paced `sendaudio` |
| `src/benchmark.js` | Submits every provider together, polls and saves raw output |
| `src/report.js` | Scores a run directory into `results.md` and `results.json` |
| `src/wer.js` | Normalisation and WER alignment |
| `src/data/english-spelling.json` | British → American spelling pairs (Whisper's list, MIT; see `src/data/NOTICE.md`) |
| `src/transcript.js` | Flattens either transcript response shape to text; refuses shapes it doesn't know |
| `src/version.js` | The harness version and commit recorded in every run |
| `server.js`, `public/` | The browser app and its local API |
| `scripts/fetch-sample.js` | Builds the pinned LibriSpeech clip |
| `scripts/score_jiwer.py` | Independent re-score with jiwer and the Whisper normaliser |

`npm test` runs the scorer (with hand-worked WER cases), the transcript parser, the `sendaudio` streaming path, full benchmarks against a stubbed API (including failed, rate-limited, unreadable and duplicate providers), the scorer's refusal to leave a results folder, and the local server's endpoints. It needs no key and no network. `npm run lint` runs ESLint.

## Attribution

The sample clip is LibriSpeech (V. Panayotov, G. Chen, D. Povey, S. Khudanpur, "LibriSpeech: an ASR corpus based on public domain audio books", ICASSP 2015), licensed CC BY 4.0.
