# Transcription provider benchmark: 2026-10-02T19-50-03Z

- Recording: bot `838eb44e-82ec-4381-be0c-ab82c9d4851a` on teams.live.com, clip `sample/clip.wav` (191.435s, sha256 `f2d2ec68f98c…`)
- Reference: 420 words after normalisation (sha256 `aed990bbd046…`)
- Rounds: 1, all providers submitted together each round; turnaround polled every 1s
- Harness: version 1.0.2, commit `9dba41b0f69c`
- Models as reported by each provider: Mia Transcribe (not reported); JigsawStack (not reported); AssemblyAI universal-2 (assemblyai_default, assemblyai_default); Deepgram general-nova-3 2025-07-31.0; Sarvam (not reported)
- Audio as reported by each provider (MeetStream sends each the same stored recording; the harness can't see the bytes): Mia Transcribe (not reported); JigsawStack (not reported); AssemblyAI 218 s; Deepgram 217.5 s, 1 channel; Sarvam audio/wav, hash 82dbb8cadf7e
- Method: see [METHODOLOGY.md](../../METHODOLOGY.md). Re-score offline with `npm run score -- results/2026-10-02T19-50-03Z`

| Provider | WER | Sub | Del | Ins | Outside clip | Turnaround (finished within) | Range over rounds | × real time (of billed audio) | Cost | Per hour |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Mia Transcribe | 1.4% | 5 | 1 | 0 | 0 words (untrimmed WER 1.4%) | 5.4–7.3s | 7.3s–7.3s | 0.03× | $0.0060 | $0.10 |
| JigsawStack | 1.4% | 5 | 1 | 0 | 0 words (untrimmed WER 1.4%) | 10.6–12.5s | 12.5s–12.5s | 0.06× | $0.0032 | $0.05 |
| AssemblyAI | 2.1% | 7 | 2 | 0 | 1 word (untrimmed WER 2.4%) | 9.1–10.6s | 10.6s–10.6s | 0.05× | $0.010 | $0.17 |
| Deepgram | 2.4% | 7 | 3 | 0 | 0 words (untrimmed WER 2.4%) | 26.1–28.3s | 28.3s–28.3s | 0.13× | $0.016 | $0.26 |
| Sarvam | 3.3% | 10 | 4 | 0 | 0 words (untrimmed WER 3.3%) | 14.0–15.6s | 15.6s–15.6s | 0.07× | $0.028 | $0.47 |

WER counts only words inside the clip: anything a provider transcribed before the clip started or after it ended (talk in the room while the bots joined) is cut first and shown under Outside clip. See METHODOLOGY.md for the rule.

WER is pooled over all successful rounds. On 420 reference words, WER gaps under 1.6 points are within sampling noise (95%, treating words as independent; real errors cluster, so the true band is wider): treat them as ties.

Turnaround is the window in which each job finished, measured from sending MeetStream's transcribe request: after the last poll that still saw it processing, and by the first poll that saw it done (polled every 1s). It is MeetStream's end-to-end turnaround (the request itself, 0.7–2.5s here, queueing, fetching the recording, the provider's processing), not the provider's own API latency. Providers whose windows overlap can't be ranked on speed.

**Cost** is transcription only, at each provider's published rate on 2026-09-28, for 3.63 min of billed audio. MeetStream's bot fee applies whichever provider is used and is not included. Rates: Mia Transcribe $0.10/hr (MeetStream transcription add-on); JigsawStack $0.99 per 1M tokens (from the response's own usage); AssemblyAI $0.15/hr Universal-2 + $0.02/hr speaker labels; Deepgram $0.0043/min (Nova-3 pre-recorded); Sarvam ₹45/hr batch with diarization, at ₹96.16/$.

## Notes

- **Mia Transcribe**: returned exactly the same transcript as JigsawStack, so almost certainly the same engine: count them as one result, not two that agree
- **JigsawStack**: returned exactly the same transcript as Mia Transcribe, so almost certainly the same engine: count them as one result, not two that agree

## Errors by provider (first successful round)

`S ref→hyp` substitution, `D ref` deletion (missed word), `I hyp` insertion. Normalised text for each provider is in `transcripts/*.normalized.txt`.

**Mia Transcribe** (6 errors): `D at`, `S em→adam`, `S birket→burkett`, `S collier→bollier`, `S the→a`, `S were→are`

**JigsawStack** (6 errors): `D at`, `S em→adam`, `S birket→burkett`, `S collier→bollier`, `S the→a`, `S were→are`

**AssemblyAI** (9 errors): `D at`, `S em→atom`, `S birket→burkett`, `S the→a`, `D michael`, `S angelo→michelangelo`, `S mantel→mantle`, `S were→are`, `S while→and`

**Deepgram** (10 errors): `D at`, `S em→atom`, `S idylls→idols`, `S birket→burkitt`, `D collier`, `S the→a`, `D michael`, `S angelo→michelangelo`, `S mantel→mantle`, `S were→are`

**Sarvam** (14 errors): `S leighton's→layton's`, `S linnell's→linell's`, `D at`, `S em→adam`, `S birket→burkett`, `D collier`, `S in→an`, `S quilter→krilter`, `D finish`, `S in→finishing`, `S the→a`, `D michael`, `S angelo→michelangelo`, `S felicitous→felicitates`

