# Transcription provider benchmark: report, 2026-10-02

Nine recordings on three meeting platforms (Google Meet, Microsoft Teams and Zoom), each transcribed by four providers: Mia Transcribe, AssemblyAI, Deepgram and Sarvam. The same sample clip was recorded six times: four times on Meet, once on Teams and once on Zoom. Three more Meet runs cover other kinds of speech: a typed script read by text-to-speech, a second clip, and a person reading aloud. Every provider succeeded on every run.

Everything below comes from the run folders listed in [runs.json](runs.json) . `node scripts/summarize.js reports/2026-10-02` regenerates every post-call table ([summary.md](summary.md), [summary.json](summary.json)), and `npm run score -- results/<run>` re-scores any single run. Method: [METHODOLOGY.md](../../METHODOLOGY.md).

## Findings

1. **Accuracy: Mia Transcribe and AssemblyAI are tied at the top, and Deepgram and Sarvam are measurably behind.** Pooled over all nine runs (3,087 reference words): Mia Transcribe 1.8%, AssemblyAI 2.2%, Deepgram 2.9%, Sarvam 3.8%. Gaps under 0.7 points are sampling noise at this size, so the top two can't be separated. Deepgram (+1.1 points) and Sarvam (+2.0) are clearly behind.
2. **The platform didn't change the order.** On the sample clip, Meet, Teams and Zoom all rank the providers the same way. Teams and Zoom scored a little lower than the Meet average (Sarvam: 4.0% on Meet, 3.3% on Teams, 2.9% on Zoom). That gap is no bigger than the spread between the four Meet recordings, so one recording each can't show that any platform's audio is better.
3. **Speed: Deepgram and Mia Transcribe are usually fastest, AssemblyAI is in the middle, and Sarvam is slowest.** Median time from request to result over eight runs: Deepgram 5.7 s, Mia Transcribe 7.4 s, AssemblyAI 10.7 s, Sarvam 18.6 s. Sarvam was the slowest in 7 of 8 runs.
4. **Turnaround swings a lot from run to run, mostly because of MeetStream.**
   - Deepgram ranged from 3.1 to 28.3 s: fastest in some runs, slowest of all on Teams.
   - Mia Transcribe ranged from 4.2 to 22.6 s.

   Only the medians and the consistent gaps mean anything; a single run can't rank providers on speed.
5. **Harder audio spreads the field.** On clip B (new sentences with rare names) every provider did worse post-call: 2.9% for Mia Transcribe, up to 7.4% for Sarvam. On clean synthetic speech, everyone scored 0–1.8%, and Deepgram's 1.8% is entirely number formatting (see below).
6. **Cost** per hour of audio, at each provider's published rate: Mia Transcribe $0.10, AssemblyAI $0.17, Deepgram $0.26, Sarvam $0.47. All nine post-call runs together cost $0.48 in transcription (MeetStream bot fees are extra).

## Results

### Accuracy, every scored run (pooled)

| Provider | Pooled WER | Range over runs | Runs | Words |
|---|---:|---:|---:|---:|
| Mia Transcribe | 1.8% | 0.0%–2.9% | 9 | 3087 |
| AssemblyAI | 2.2% | 0.0%–3.7% | 9 | 3087 |
| Deepgram | 2.9% | 1.8%–5.9% | 9 | 3087 |
| Sarvam | 3.8% | 0.0%–7.4% | 9 | 3087 |

Gaps under 0.7 points are within sampling noise (95%, treating words as independent; real errors cluster, so the true band is wider).

### The sample clip on each platform

| Provider | All 6 recordings | Google Meet (4) | Microsoft Teams (1) | Zoom (1) |
|---|---:|---:|---:|---:|
| Mia Transcribe | 1.9% | 2.1% | 1.4% | 1.2% |
| AssemblyAI | 2.2% | 2.3% | 2.1% | 2.1% |
| Deepgram | 2.7% | 3.0% | 2.4% | 1.9% |
| Sarvam | 3.7% | 4.0% | 3.3% | 2.9% |

### Accuracy by run

| Provider | 1 Meet | 2 Meet | 3 Meet | 4 Meet | 5 script | 6 clip B | 7 person | 8 Teams | 9 Zoom |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Mia Transcribe | 1.4% | 2.9% | 2.9% | 1.4% | 0.0% | 2.9% | 0.8% | 1.4% | 1.2% |
| AssemblyAI | 2.6% | 2.4% | 2.1% | 1.9% | 0.0% | 3.7% | 0.8% | 2.1% | 2.1% |
| Deepgram | 3.1% | 2.9% | 3.6% | 2.6% | 1.8% | 5.9% | 2.4% | 2.4% | 1.9% |
| Sarvam | 3.8% | 3.8% | 5.0% | 3.6% | 0.0% | 7.4% | 2.4% | 3.3% | 2.9% |

Runs 1–4, 8 and 9 are the sample clip; run 5 is the typed script, run 6 clip B, and run 7 a person reading (all on Meet). The same clip recorded four times on Meet gives a provider up to 1.5 points of spread (Mia Transcribe 1.4–2.9%, Sarvam 3.6–5.0%). That's how much a single recording can move a score.

### Turnaround, the eight runs polled every second

| Provider | Median | Fastest run | Slowest run |
|---|---:|---:|---:|
| Deepgram | 5.7 s | 3.1 s | 28.3 s |
| Mia Transcribe | 7.4 s | 4.2 s | 22.6 s |
| AssemblyAI | 10.7 s | 9.3 s | 14.7 s |
| Sarvam | 18.6 s | 14.4 s | 31.1 s |

This is MeetStream's end-to-end time: from sending the re-transcribe request to the first poll that saw the result. It includes MeetStream's queueing, not just the provider's processing. Each value is known to within 1 s. Per-run windows are in [summary.md](summary.md). Run 1 (Test 1) used a 5 s poll and isn't included.

### The independent scorer

`scripts/score_jiwer.py` ([its output](jiwer-crosscheck.txt); jiwer with OpenAI Whisper's normaliser, written by neither MeetStream nor this harness) re-scored all nine runs. Its figures differ from ours by up to 1.2 points, in both directions:
- Whisper's normaliser counts compound spacing ("upguards"/"up guards") as errors, and ours doesn't.
- It reads Deepgram's "$4,200,000" as the same amount as "four point two million dollars", and ours doesn't. That's the largest single difference: Deepgram on the typed script, 1.8% ours versus 0.6% jiwer.

It puts the providers in the same order in every run, except where two of them are within noise of each other.

## What each test was

| # | Test | Platform | Audio | Reference |
|---|---|---|---|---|
| 1–4 | Sample clip | Google Meet | 191 s of LibriSpeech dev-clean read speech (pinned file, `sample/manifest.json`), played into the call by a speaker bot | Its exact transcript, 420 words |
| 5 | Typed script | Google Meet | A 169-word meeting-style script ([inputs/tts-script.txt](inputs/tts-script.txt)) spoken by Windows' built-in voice, 67.5 s ([inputs/tts-speech.wav](inputs/tts-speech.wav)) | The script itself |
| 6 | Own audio file | Google Meet | Clip B: the next 23 utterances of the same pinned file, 122.5 s ([inputs/build-clip-b.js](inputs/build-clip-b.js) rebuilds it byte-identical) | Its exact transcript, 272 words |
| 7 | A person reading aloud | Google Meet | A person reading a 126-word script ([inputs/read-aloud-script.txt](inputs/read-aloud-script.txt)) into the call. Recorder bot only | The script, added after the run, with one word corrected to what the reader said |
| 8 | Sample clip | Microsoft Teams | As runs 1–4 | As runs 1–4 |
| 9 | Sample clip | Zoom | As runs 1–4 | As runs 1–4 |

Runs 2–7 were benchmarked with harness commit `d1e29bc`, run 8 with `9dba41b` and run 9 with `7ad01ba`, each with no uncommitted changes and polling every second. Run 1 is the earlier Test 1 (28 Sep, 5 s poll, harness commit not recorded). All nine were scored with normaliser v3. Every run folder holds the raw response from each provider, the reference, and the normalised texts.

## Things found during these runs

- **Two scoring rules were added and applied to every run.** On the typed script, every provider wrote "$4.2 million" for "four point two million dollars", and three wrote "November 14" for "November fourteenth". Both were charged as errors. Normaliser v3 now reads money with a scale word and month-day dates the way they're said. Re-scoring changed only the typed-script run (Mia Transcribe, AssemblyAI and Sarvam went from 1.2–1.8% to 0.0%; Deepgram from 2.4% to 1.8%).
- **Deepgram writes large amounts as digits** ("$4,200,000"). That's the same amount, but it's still charged here. It's Deepgram's entire 1.8% on the typed script.
- **The person-reading run's reference was corrected for one word the reader confirmed.** Every provider heard "**This** is the end" where the script says "**That** is the end". The reader confirmed "This", and `run.json` records the change, why, and the previous hash. All of them also wrote "one hundred twelve" where the script says "one hundred **and** twelve". That wasn't confirmed, so it's left as written and costs every provider the same 0.8 points.
- **Zoom needs setup that Meet and Teams don't.**
  - MeetStream needs a Zoom Meeting SDK app's credentials, with "programmatic join" enabled. Without them the bot is refused, or fails with a Zoom authentication error.
  - The meeting host must allow the bot to record when Zoom asks. Otherwise it leaves after about a minute with nothing captured.
  - A Zoom bot stays in status "Stopped" after its recording is processed (Meet and Teams bots move on to "Done").

  The harness now reports each of these in plain words, stops playback when the recorder leaves, and recognises a processed Zoom recording.

## Limitations

- **Speakers.** The sample clip and clip B are all one LibriSpeech speaker (1272): the pinned file contains no one else. The typed script is one synthetic voice, and the read-aloud run one person. Accents, crosstalk and spontaneous speech aren't tested.
- **Read speech, not meetings.** Nothing here is a real conversation. LibriSpeech is also public and may be in some providers' training data, which can flatter them on the sample clip and clip B.
- **Platforms.** Four recordings on Google Meet, but only one each on Teams and Zoom. That's enough to show the order holds on all three, not to compare the platforms' audio quality.
- **Sample size.** 3,087 reference words in total; gaps under 0.7 points are noise. Four recordings of one clip show up to 1.5 points of spread per provider.
- **Turnaround** is through MeetStream, from one machine and one network, over about 90 minutes on one evening. Load at other times may differ.
- **Settings.** Each provider uses its documented English setting through MeetStream, with defaults otherwise: `auto` for Mia Transcribe, `en` for Deepgram, `en_us` for AssemblyAI, `en-IN` for Sarvam.
- **Same audio for every provider** follows from MeetStream's design (one stored recording, re-transcribed per provider). The harness can't see the bytes MeetStream sends each one. The lengths providers report agree.
- **Not tested:** diarization, timestamps, and the provider's own API latency.
- **Conflict of interest.** MeetStream wrote this harness and sells one of the engines measured (Mia Transcribe). Every number here can be re-derived from the published folders without trusting it.
