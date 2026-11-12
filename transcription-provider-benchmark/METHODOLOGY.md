# Methodology

This harness compares the post-call transcription providers MeetStream offers. MeetStream wrote it and sells one of the engines it measures (`meetstream`, shown as Mia Transcribe in the dashboard). You should read any number it produces with that in mind. This document says exactly what is measured and what is not, and how to check a published result without trusting us.

## What is compared

| Provider key | Engine and config sent | Needs dashboard setup |
|---|---|---|
| `meetstream` (shown as **Mia Transcribe**) | MeetStream's engine, which runs on JigsawStack, `language: "auto"` | No |
| `deepgram` | Deepgram `nova-3`, `language: "en"` | Deepgram key under Integrations |
| `assemblyai` | AssemblyAI `universal-2`, `language_code: "en_us"` | AssemblyAI key under Integrations |
| `sarvam` | Sarvam `saaras:v3`, `mode: "transcribe"`, `language_code: "en-IN"` | Sarvam key under Integrations |
| `jigsawstack` | JigsawStack, `language: "en"` | JigsawStack key under Integrations |

The exact request bodies live in [src/providers.js](src/providers.js), and every run copies them into `run.json`. The rule behind them: use each provider's documented model, set English wherever the provider documents an English code, and leave every other option at the provider's default. No custom vocabulary, keyterm prompts or other tuning is applied for the sample clip.

**Mia Transcribe and JigsawStack are one engine.** Mia Transcribe runs on JigsawStack. In the published run they returned exactly the same transcript, in JigsawStack's response format, so the table has four independent results, not five. `results.md` flags any two providers whose transcripts are identical, so this shows up in every run.

Two choices deserve comment:

- **`meetstream` runs on `auto`, not English.** MeetStream's docs don't confirm an English code for it. Auto-detection can only cost it accuracy, so the choice cuts against our own engine, not for it.
- **`sarvam` runs with `en-IN`.** It is the only English code in Sarvam's MeetStream docs. The sample is American and British read speech, so this may disadvantage Sarvam.

"All supported providers" means every transcription provider a MeetStream customer can turn on today: the five on the dashboard's Integrations → Transcription page. The page's "Soon" entries (ElevenLabs, Azure Speech, Gladia, Speechmatics) are not usable yet. The API also names `aws_transcribe`, but it isn't on that page and the API refuses it ("batch transcription is not enabled for the US execution plane"), so it isn't included.

`meeting_captions` is excluded. It reads the meeting platform's live captions during the call, so it can't be re-run on a finished recording and would not hear the same audio as the others.

## Same audio for every provider

This is the property the rest of the design depends on.

1. **Record once.** Two MeetStream bots join one meeting. The *speaker* plays the reference clip into the call through the bot `sendaudio` command. The *listener* records the call, the way a customer's notetaker would. The clip therefore passes through the platform's real audio path (codec, mixing, network), not a clean file upload.
2. **Transcribe many times.** `POST /bots/{listener}/transcribe` is called once per provider. Each call re-transcribes the listener's single stored recording, so by MeetStream's design every provider gets the same input, and accuracy differences can't come from one provider getting cleaner audio.

The harness can't verify that last step: MeetStream sends the audio to each provider, and the harness never sees those bytes, so it can't rule out MeetStream converting the recording differently per provider. What it can do is record what each provider reports receiving. `results.md` lists it under "Audio as reported by each provider". In the published run, Deepgram reports 257.2 s of mono audio, AssemblyAI 258 s, and Sarvam a WAV file; the others don't say. The lengths agree, which is consistent with one recording, not proof of identical bytes.

MeetStream runs each provider **once per recording**. Its docs don't say so, but the API enforces it in two ways:

- `meetstream` a second time on the same bot answers HTTP 409: "can only be used once per bot".
- Any other provider a second time with the same config is accepted, then fails with "Equivalent retranscription work was already claimed".

Consequences:

- The listener's live transcript uses `meeting_captions`. That leaves every provider's one run for the benchmark, where it is timed.
- One recording gives **one turnaround sample per provider**. To sample turnaround more than once, record again (`npm run record`, then `npm run benchmark`) and compare runs.
- Benchmarking a bot where a provider already ran scores the transcript from that earlier run. Accuracy is still comparable (same recording, and the note says if the config differed), but turnaround shows as "–" and `results.md` explains why.

**Typed scripts.** Instead of a clip, the speaker bot can read out text you type (`--script`, or "Type what the bot says" in the app), using the operating system's text-to-speech:
- Windows uses System.Speech, macOS uses `say`, and Linux uses `espeak-ng`.
- The text you type is the reference, so accuracy needs no separate transcript.
- Synthetic speech is steadier and clearer than people talking, so WER on it reads lower. Compare providers against each other on the same script, not against results from human speech.
- `run.json` records which engine spoke it (`clip.synthetic_speech`).

You can also benchmark any existing bot (`--bot-id`) that recorded speech you have a verbatim reference for. Step 2 is the same.

## The sample clip

`npm run fetch-sample` builds `sample/clip.wav` and `sample/reference.txt` from **LibriSpeech dev-clean** (Panayotov et al., 2015, CC BY 4.0), using a 73-utterance slice that Hugging Face hosts as one parquet file:

- The file is pinned by commit (`5be9148…`) and checked by SHA-256 before use.
- Utterances are taken **in file order** until the clip reaches 180 s. That gives 18 utterances, 191.4 s and 420 reference words. Nobody chose which sentences to include.
- Utterances are joined with 0.75 s of silence and written as 16 kHz mono WAV. With the pinned `ffmpeg-static`, the clip is byte-identical on every build; `sample/manifest.json` records its SHA-256 (`f2d2ec68…`).

LibriSpeech is read audiobook speech: one speaker at a time, careful diction, no crosstalk, no disfluencies. It is the standard reference set because its transcripts are exact. It is **not** representative of meetings (see Limitations).

## Accuracy: word error rate

WER = (substitutions + deletions + insertions) ÷ reference words, from a minimum-edit alignment of normalised reference and hypothesis words. It can exceed 100%. If a run holds more than one round, errors and reference words are summed before dividing (pooled), not averaged per round.

Before alignment, the same normalisation is applied to both the reference and each provider's output ([src/wer.js](src/wer.js)), so formatting isn't counted as misrecognition:

1. Unicode NFKC, lower-case, curly apostrophes made straight.
2. `&` becomes "and", `$5` becomes "5 dollars" and `$4.2 million` "4.2 million dollars" (the order it's said in), `12%` becomes "12 percent", a day after a month becomes an ordinal (`November 14` → November fourteenth), and thousands separators are removed.
3. Hyphens and dashes become spaces. All other punctuation is removed, except apostrophes inside words (`quilter's`) and decimal points. Letters and combining marks in any script are kept: in Tamil, Hindi and other Indic scripts the vowel signs are combining marks, and dropping them would split words apart and make different words look identical.
4. Spoken abbreviations are expanded: `mr` mister, `mrs` missus, `ms` miss, `dr` doctor, `st` saint, `vs` versus.
5. Digits become words the way they are usually spoken:
   - `25` → twenty five, `2nd` → second, `3.5` → three point five
   - 4-digit numbers from 1100 to 2099 read as years (`1905` → nineteen oh five, `2005` → two thousand five), `1990s` → nineteen nineties
   - numbers over 12 digits are read digit by digit
6. The fillers um, uh, hmm, mm, mhm, mmm and erm are dropped, since a reader never says them.
7. British spellings become American (`recognising` → recognizing, `colour` → color), using Whisper's list of 1,739 pairs ([src/data/NOTICE.md](src/data/NOTICE.md)).
8. Contractions with only one reading are expanded: `n't` → not (`won't` → will not, `can't` and `cannot` → can not), `'re` → are, `'ve` → have, `'ll` → will, `'m` → am. `'s` (is, has or possessive) and `'d` (had or would) are ambiguous and left as written.

After alignment, one more rule: **compound words match however they're spaced.** A run of errors whose reference and hypothesis words join to the same letters (`up guards` / `upguards`, `mantel board` / `mantelboard`) is scored as correct, and still counts as the reference's number of words. A different spelling (`michael angelo` / `michelangelo`) doesn't join to the same letters and stays an error.

Rules 7, 8 and the compound rule were added on 2026-09-30, after an audit found that formatting differences were charged unevenly: they moved some providers by up to 1.2 points on Test 1, more than the gaps between them. Test 1 was re-scored from the same raw transcripts; every error removed was a formatting difference, and the ranking didn't change. `results.json` names the normaliser version that scored a run.

**Ties.** On a small reference, a gap of a word or two is noise. The report computes a 95% band for the difference between two WERs near the best one, from the number of reference words (`wer_tie_band` in `results.json`; 1.6 points on the 420-word sample), and the app calls every provider inside it tied. It treats words as independent; real errors cluster, so the true band is if anything wider.

**Only the clip is scored.** The listener records from the moment it joins, so anything said in the room before the clip starts (for example while the speaker bot waits to be admitted) or after it ends is in every transcript. It would otherwise count as insertion errors, and it would hit hardest the providers most willing to transcribe background speech. Before scoring, each transcript is cut to the clip ([src/wer.js](src/wer.js) `clipWindow`):

- The clip's edges are the first and last runs of 3 consecutive words the provider got right.
- Before the first run, the provider keeps as many words as the reference has there, so mistakes on the clip's opening words still count. Anything earlier is outside the clip. The end is handled the same way.
- Talk *during* the clip is not cut, and counts as insertions.
- If a transcript has no run of 3 correct words, nothing is cut.

The cost of this rule: a genuine insertion right at the very start or end of the clip isn't counted. `results.md` shows how many words were cut per provider and the untrimmed WER beside the trimmed one, and `score_jiwer.py` applies the same rule on jiwer's own alignment. On a recording made in a quiet room nothing is cut, and both figures match.

Speaker labels are ignored: this measures which words were heard, not who said them. Segments are put in start-time order before joining.

**Checking the scorer.** [scripts/score_jiwer.py](scripts/score_jiwer.py) shares no code with the Node scorer. It re-scores the same raw transcripts with [jiwer](https://github.com/jitsi/jiwer) and OpenAI Whisper's `EnglishTextNormalizer`, the combination most ASR papers use. During development:

- On identical normalised text, `src/wer.js` and jiwer gave the same WER to the last decimal place for every provider.
- The S/D/I *split* can differ when two alignments are equally short, for example one substitution vs. one deletion plus one insertion. Totals never differ.
- With Whisper's normaliser instead of ours, the ranking doesn't change. On Test 1 its WERs are up to 1.1 points higher, because it counts compound spacing (`upguards` for `up guards`) as errors and ours doesn't. Publish both tables.

## Turnaround time

What is measured, from the harness's clock:

| Time | Event |
|---|---|
| T0 | the harness sends `POST /bots/{id}/transcribe` |
| T1 | MeetStream answers the request (`request_s` in `run.json`: about 1–2.5 s in practice) |
| … | MeetStream queues the job, fetches the recording, the provider transcribes it |
| T2 | the job finishes: **not observable**; only the polls around it are |
| T3 | the first poll of `GET /bots/{id}/transcriptions` that reports it finished |

Fetching the transcript, normalising and scoring happen after T3 and are not counted.

- **Turnaround is a window, not a number.** The job finished after the last poll that still saw it processing and by T3. Both ends are measured from T0: `turnaround_lower_bound_s` and `turnaround_s` in `run.json`. The table shows the window, e.g. `2.5–8.6s`.
- **Providers whose windows overlap can't be ranked on speed.** With a 5 s poll, and a first poll only after every request has returned, anything that finishes within about 8.6 s looks the same. That's why the published run (5 s poll) can't separate Mia Transcribe from Deepgram. The default is now a 1 s poll (`--poll`).
- It measures **turnaround through MeetStream**: the request itself, queueing, fetching the recording, the provider's own processing and storing the result. It is what a MeetStream customer waits, not the provider's API latency, which this harness can't see.
- All providers are submitted at the same moment so they run under the same load. A provider submitted on its own (a resubmission after a failure, or `--append`) is marked ‡ and left out of "fastest", because it didn't run under the same conditions.
- Each provider gets one sample per recording (see above), so treat a single run's turnaround as indicative. For a speed claim, record several times and compare the windows' median and spread.
- **Re-running a recording isn't a new test.** MeetStream runs each provider once per recording, so a second benchmark of the same bot reuses the first run's transcripts, untimed. The app warns before you do it. An earlier transcript is only reused if MeetStream reports the same model and settings (or doesn't report them); one made with a different model, say `nova-2` for `nova-3`, is not scored under this provider's name.
- **Without a reference, words transcribed is not a score.** A provider that returns more words may be hallucinating or picking up background talk, so the app shows the count but doesn't call anyone best on it.
- **Failed attempts are retried once.** A job that fails inside MeetStream before reaching the provider ("Retranscription failed before provider submission") tells you nothing about that provider, so it is resubmitted once. You can also re-run a provider into an existing run with `--append`. Either way, `run.json` keeps every attempt, and `results.md` notes the retry and that the provider wasn't timed alongside the others.
- **Fallback: live transcription.** If the re-transcribe endpoint refuses a provider that works at bot creation (this happened to AssemblyAI for part of 2026-09-28), `npm run record -- --live-provider <p>` runs it live on the recording bot. Its turnaround is then timed from the bots leaving the call, which includes MeetStream's post-call media processing, so the table marks it with † as not comparable.
- "× real time" is the turnaround divided by the clip length. For example, 0.25× means a 3-minute clip took 45 s.

## Cost

Cost is **transcription only**, at each provider's published pay-as-you-go rate. The rates and their date are in [src/pricing.js](src/pricing.js), and each one is worked out from what the provider actually billed for, read from its own raw response (`transcripts/*.raw.json`):

| Provider | Rate (2026-09-28) | Billed on |
|---|---|---|
| `meetstream` | $0.10/hr (MeetStream's transcription add-on) | audio length |
| `deepgram` | $0.0043/min (Nova-3 pre-recorded) | audio length |
| `assemblyai` | $0.15/hr for Universal-2, plus $0.02/hr for speaker labels, which are on by default | audio length |
| `sarvam` | ₹45/hr for batch with diarization, which is on by default; ₹30/hr without | audio length, converted at ₹96.16 to the dollar |
| `jigsawstack` | $0.99 per million tokens | its own token count (mostly processing time), so its per-hour cost varies with the audio |

Details:
- **Audio length** comes from Deepgram's `metadata.duration` or AssemblyAI's `audio_duration`. That's the whole recording, not just the clip.
- **MeetStream's bot fee ($0.35/hr) is left out.** You pay it whichever provider transcribes.
- **No markup on third-party providers.** They bill your own key directly.
- **Minimums aren't modelled.** Some providers round up or have minimum charges, so an invoice for very short audio can be higher than the figure here.

## Limitations

- **Not meeting speech.** The default clip is read English. Conversational speech, accents, crosstalk, jargon and code-switching all change WER and can change rankings. To measure those, use `--audio` and `--reference` with your own recording and a verbatim transcript.
- **Background speech during the clip still counts.** Keep the room silent while the clip plays.
- **Small sample, one run.** One word is 0.24 points of WER on 420 reference words, and gaps under 1.6 points are within sampling noise (see Ties). The published result is one recording of one clip: one accuracy figure and one turnaround sample per provider, with no measure of spread. For claims, record at least 5 times on at least 3 clips, including real meeting audio, and publish the median, spread and p95 turnaround.
- **The sample may be in providers' training data.** LibriSpeech is public and widely used, so some engines may have seen these exact recordings. That can flatter them relative to audio they haven't seen, and it may favour some providers more than others. Your own recordings don't have this problem.
- **Language settings differ.** Each provider gets its documented English setting: `auto` for Mia Transcribe (no English code documented), `en` for Deepgram and JigsawStack, `en_us` for AssemblyAI, `en-IN` for Sarvam. See "Two choices deserve comment" above.
- **One platform per recording.** Google Meet, Zoom and Teams process audio differently. Record once per platform if that matters to you.
- **Default configs.** Providers can often do better with vocabulary hints or tuned settings. The table shows out-of-the-box behaviour through MeetStream.
- **Not measured:** diarization accuracy, timestamp accuracy, the provider's own API latency, and live (streaming) latency.

## Publishing a result

Any result MeetStream publishes should include:

1. The whole `results/<run>/` directory: `run.json`, the raw transcript JSON from every provider, the normalised texts, `results.md` and `results.json`.
2. The commit of this harness used to produce it. Runs record it themselves (`harness_version` in `run.json`, the "Harness" line in `results.md`), with a warning if the harness had uncommitted changes. Publish only runs made from a clean commit. Each provider's reported model (e.g. Deepgram's `general-nova-3 2025-07-31.0`) is recorded too, because the model names sent in requests are aliases that change over time.
3. The `score_jiwer.py` table beside ours.
4. This document, or a link to it, and the limitations above.

## Reproducing a result

With nothing but a published `results/<run>/` directory and no API key:

```bash
npm install
npm run score -- results/<run>
pip install -r scripts/requirements.txt
python scripts/score_jiwer.py results/<run>
```

To check the reference is the one that was scored, compare `sha256sum results/<run>/reference.txt` with `reference.sha256` in `run.json`. Reference hashes are taken over LF line endings, and `.gitattributes` checks results out with LF on every OS, so they match on Windows, macOS and Linux. (Test 1's hash was first recorded over a Windows CRLF copy; `run.json` keeps that value in `sha256_note`.)

To re-run the measurement end to end on your own account, follow the README. Your WER should land close to the published figure. It will not match exactly, because providers update their models and every live recording differs slightly. Turnaround depends on load and time of day.
