# Transcription Provider Benchmark

This harness runs **one meeting recording through every transcription provider MeetStream supports** and outputs a table of word error rate and turnaround time.

**Latest report: [reports/2026-10-02](reports/2026-10-02/REPORT.md)** ([PDF](reports/2026-10-02/REPORT.pdf)). Nine recordings on Google Meet, Microsoft Teams and Zoom, each sent to all five providers: the sample clip recorded six times (four on Meet, one on Teams, one on Zoom), a typed script read by text-to-speech, a second clip, and a person reading aloud. 3,087 reference words in total, and every provider succeeded on every run. The report also covers live (streaming) transcription with Deepgram and AssemblyAI.

| Provider | WER (pooled, 9 runs) | Range over runs | Turnaround (median, 8 runs) | Slowest run | Per hour |
|---|---:|---:|---:|---:|---:|
| Mia Transcribe ◆ | 1.8% | 0.0–2.9% | 7.4 s | 22.6 s | $0.10 |
| JigsawStack ◆ | 1.9% | 0.0–3.7% | 6.0 s | 12.5 s | ~$0.03* |
| AssemblyAI | 2.2% | 0.0–3.7% | 10.7 s | 14.7 s | $0.17 |
| Deepgram | 2.9% | 1.8–5.9% | 5.7 s | 28.3 s | $0.26 |
| Sarvam | 3.8% | 0.0–7.4% | 18.6 s | 31.1 s | $0.47 |

◆ **One engine, two names.** Mia Transcribe runs on JigsawStack. They returned the same transcript in 8 of 9 runs, and differed on just 2 rare names in the other. Count them as one result.
\*JigsawStack bills by processing tokens, so its per-hour cost depends on the audio.

How to read this:

- **Accuracy:** Mia Transcribe/JigsawStack and AssemblyAI are tied at the top: gaps under 0.7 points are sampling noise on 3,087 words. Deepgram (+1.1 points) and Sarvam (+2.0) are measurably behind. The same order holds on the sample clip on each platform: Meet, Teams and Zoom.
- **Speed varies a lot from run to run, mostly because of MeetStream.** In one run the same engine took 22.6 s as Mia Transcribe and 5.0 s as JigsawStack. Only the medians and the consistent gaps mean anything: Deepgram, JigsawStack and Mia Transcribe are fastest, AssemblyAI is in the middle, and Sarvam was slowest in 7 of 8 runs. Turnaround is MeetStream's end-to-end time from the re-transcribe request, known to within 1 s, not the provider's own API latency.
- **Live (streaming):** on the sample clip, AssemblyAI live scored 1.2% and Deepgram Nova-3 live 3.6%, with final text a median 0.3–0.4 s after each phrase.
- **One recording isn't enough.** The same clip recorded four times moved a provider's WER by up to 1.5 points.
- **Scored on words, not formatting.** Spelling conventions, contractions, compound spacing, "$4.2 million" and "November 14" aren't counted as errors (see [METHODOLOGY.md](METHODOLOGY.md#accuracy-word-error-rate)). The independent scorer (`scripts/score_jiwer.py`, jiwer with Whisper's normaliser) puts the providers in the same order.
- **Limits:** one LibriSpeech speaker on the clips, one synthetic voice, one person reading; read speech, not meetings; one recording each on Teams and Zoom; LibriSpeech may be in providers' training data. Each provider uses its documented English setting (`auto` for Mia Transcribe, `en-IN` for Sarvam).
- **Written by an interested party.** MeetStream wrote this harness and sells one of the engines it measures. Every number can be re-derived from the published run folders without trusting it.

The earlier single-run result (Test 1, 28 Sep) is run 1 of the report, and its folder is [results/2026-09-28T18-08-58Z](results/2026-09-28T18-08-58Z/results.md).

**Read [METHODOLOGY.md](METHODOLOGY.md) before trusting any number this produces.** It covers what is measured and what is not, how each provider is configured, and how to check a result with a scorer MeetStream did not write.

## Related: live providers

This harness compares MeetStream's **post-call** providers: the ones you configure on the dashboard's Integrations page, run on a finished recording.

[`../realtime-audio-streaming`](../realtime-audio-streaming) is the example that switches between **live streaming** providers (Deepgram, AssemblyAI, OpenAI) during a call. Its `npm run compare` sends the same audio to all of them at once and tabulates WER and finalisation latency with this harness's scorer. Point it at this harness's `sample/clip.wav` and `sample/reference.txt` to put live and post-call numbers on the same clip.

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
4. **Mia Transcribe** (`meetstream`) is MeetStream's own engine and needs nothing.

A provider you haven't connected still appears in the results, marked "not run" with the API's reason. To leave it out, untick it in the app or pass `--providers`. The app's New benchmark page shows these steps too.

## Desktop app (Windows, macOS, Linux)

The same UI is also packaged as a desktop app, for people who shouldn't need Node, npm or a terminal. Download it from the **[Transcriber Benchmark 1.0.3 release](https://github.com/ThalhaAhamed/labs/releases/tag/transcriber-benchmark-v1.0.3)**, [connect the providers](#before-your-first-run-connect-the-providers) in MeetStream if you haven't yet, and open **Transcriber Benchmark**.

| OS | Installer |
|---|---|
| Windows 10/11 (x64) | `Transcriber-Benchmark-1.0.3-Windows.exe` |
| macOS, Apple silicon | `Transcriber-Benchmark-1.0.3-Mac-arm64.dmg` |
| macOS, Intel | `Transcriber-Benchmark-1.0.3-Mac-x64.dmg` |
| Linux (x64) | `Transcriber-Benchmark-1.0.3-Linux-x86_64.AppImage` (make it executable and run it), or `Transcriber-Benchmark-1.0.3-Linux-amd64.deb` (`sudo apt install ./<file>.deb`) |

The installers aren't code-signed yet, so the first launch asks you to confirm:
- **Windows:** SmartScreen shows "More info → Run anyway".
- **macOS:** right-click the app and choose Open.

Inside the app:
- **Everything the browser version does,** with Node bundled (the app runs the same `index.js` through Electron).
- **Data lives in your user folder,** not next to the app: `%APPDATA%\Transcriber Benchmark` on Windows, `~/Library/Application Support/Transcriber Benchmark` on macOS, and `~/.config/Transcriber Benchmark` on Linux. Settings shows where, how much space each part takes, and opens the folder. The published example run and the sample clip are copied in on first launch.
- **Keys are set in Settings** (MeetStream API key, and the ngrok authtoken for the speaker bot). They're remembered, encrypted by the operating system's key store (DPAPI, Keychain or libsecret). If no key store is available, they're kept in memory only. Settings can also test the MeetStream key.
- **Providers** shows each provider's exact settings, price and caveats, and how it has done across your runs.
- **Small:** about 340 MB installed (a 111 MB installer on Windows), most of it Electron itself. The app leaves out ffmpeg (80 MB) and ships English UI strings only. Everything it plays is WAV: the sample clip ships with it, text-to-speech writes WAV, and the page converts any other audio file to WAV before sending it.

**Building the installers.** Each installer has to be built on its own OS, because ngrok ships a native binary for the machine that runs `npm ci`. The build makes the sample clip first if the checkout doesn't have it (that step uses ffmpeg, which the command line keeps).

```bash
npm run desktop        # run the desktop app from source
npm run dist:win       # on Windows → dist/*.exe
npm run dist:mac       # on a Mac   → dist/*.dmg (for that Mac's chip)
npm run dist:linux     # on Linux   → dist/*.AppImage and *.deb
```

- **Linux from Windows or macOS:** `build/linux-in-docker.sh` builds and smoke-tests the Linux installers inside a Docker container (instructions at the top of the file).
- **All of them at once:** the GitHub Actions workflow `.github/workflows/transcription-benchmark-desktop.yml` builds Windows, macOS on both chips, and Linux on their own runners. Run it from the Actions tab, or push a `transcriber-benchmark-v*` tag. The Linux job also smoke-tests the packaged app.
- **The icon** (a video call whose speech becomes a transcript and a chart, on an orange tile) is built by `build/make-icon.py` from `build/icon-source.png`, the supplied design cut out along its rounded corners, as PNG, ICO and ICNS. Every size uses the same picture.

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
| `scripts/summarize.js` | A multi-run report's tables, computed from the run folders it lists (`node scripts/summarize.js reports/<date>`) |
| `scripts/report-pdf.js` | Renders a report's `REPORT.md` to `REPORT.pdf` (`npm run report-pdf -- reports/<date>`) |
| `reports/` | Published reports: the narrative, the list of runs, the generated tables and every test input |

`npm test` runs the scorer (with hand-worked WER cases), the transcript parser, the `sendaudio` streaming path, full benchmarks against a stubbed API (including failed, rate-limited, unreadable and duplicate providers), the scorer's refusal to leave a results folder, and the local server's endpoints. It needs no key and no network. `npm run lint` runs ESLint. The desktop workflow runs both before building any installer.

## Attribution

The sample clip is LibriSpeech (V. Panayotov, G. Chen, D. Povey, S. Khudanpur, "LibriSpeech: an ASR corpus based on public domain audio books", ICASSP 2015), licensed CC BY 4.0.
