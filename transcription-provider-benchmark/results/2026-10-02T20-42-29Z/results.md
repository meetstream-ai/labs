# Transcription provider benchmark: 2026-10-02T20-42-29Z

- Recording: bot `5b8598ac-41c2-4d32-8c40-77cfac122bb9` on us05web.zoom.us, clip `sample/clip.wav` (191.435s, sha256 `f2d2ec68f98c…`)
- Reference: 420 words after normalisation (sha256 `aed990bbd046…`)
- Rounds: 1, all providers submitted together each round; turnaround polled every 1s
- Harness: version 1.0.2, commit `7ad01baaf6f0`
- Models as reported by each provider: Mia Transcribe (not reported); JigsawStack (not reported); Deepgram general-nova-3 2025-07-31.0; AssemblyAI universal-2 (assemblyai_default, assemblyai_default); Sarvam (not reported)
- Audio as reported by each provider (MeetStream sends each the same stored recording; the harness can't see the bytes): Mia Transcribe (not reported); JigsawStack (not reported); Deepgram 208.9 s, 1 channel; AssemblyAI 209 s; Sarvam audio/wav, hash f97ef5df1a4a
- Method: see [METHODOLOGY.md](../../METHODOLOGY.md). Re-score offline with `npm run score -- results/2026-10-02T20-42-29Z`

| Provider | WER | Sub | Del | Ins | Outside clip | Turnaround (finished within) | Range over rounds | × real time (of billed audio) | Cost | Per hour |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Mia Transcribe | 1.2% | 4 | 1 | 0 | 0 words (untrimmed WER 1.2%) | 7.4–9.3s | 9.3s–9.3s | 0.04× | $0.0058 | $0.10 |
| JigsawStack | 1.2% | 4 | 1 | 0 | 0 words (untrimmed WER 1.2%) | 4.0–5.5s | 5.5s–5.5s | 0.03× | $0.0017 | $0.03 |
| Deepgram | 1.9% | 6 | 2 | 0 | 0 words (untrimmed WER 1.9%) | 2.5–4.0s | 4.0s–4.0s | 0.02× | $0.015 | $0.26 |
| AssemblyAI | 2.1% | 6 | 3 | 0 | 0 words (untrimmed WER 2.1%) | 9.3–10.9s | 10.9s–10.9s | 0.05× | $0.0099 | $0.17 |
| Sarvam | 2.9% | 10 | 2 | 0 | 0 words (untrimmed WER 2.9%) | 14.6–16.2s | 16.2s–16.2s | 0.08× | $0.027 | $0.47 |

WER counts only words inside the clip: anything a provider transcribed before the clip started or after it ended (talk in the room while the bots joined) is cut first and shown under Outside clip. See METHODOLOGY.md for the rule.

WER is pooled over all successful rounds. On 420 reference words, WER gaps under 1.5 points are within sampling noise (95%, treating words as independent; real errors cluster, so the true band is wider): treat them as ties.

Turnaround is the window in which each job finished, measured from sending MeetStream's transcribe request: after the last poll that still saw it processing, and by the first poll that saw it done (polled every 1s). It is MeetStream's end-to-end turnaround (the request itself, 0.7–2.4s here, queueing, fetching the recording, the provider's processing), not the provider's own API latency. Providers whose windows overlap can't be ranked on speed.

**Cost** is transcription only, at each provider's published rate on 2026-09-28, for 3.48 min of billed audio. MeetStream's bot fee applies whichever provider is used and is not included. Rates: Mia Transcribe $0.10/hr (MeetStream transcription add-on); JigsawStack $0.99 per 1M tokens (from the response's own usage); Deepgram $0.0043/min (Nova-3 pre-recorded); AssemblyAI $0.15/hr Universal-2 + $0.02/hr speaker labels; Sarvam ₹45/hr batch with diarization, at ₹96.16/$.

## Notes

- **Mia Transcribe**: returned exactly the same transcript as JigsawStack, so almost certainly the same engine: count them as one result, not two that agree
- **JigsawStack**: returned exactly the same transcript as Mia Transcribe, so almost certainly the same engine: count them as one result, not two that agree

## Errors by provider (first successful round)

`S ref→hyp` substitution, `D ref` deletion (missed word), `I hyp` insertion. Normalised text for each provider is in `transcripts/*.normalized.txt`.

**Mia Transcribe** (5 errors): `D at`, `S em→adam`, `S birket→burkett`, `S the→a`, `S were→are`

**JigsawStack** (5 errors): `D at`, `S em→adam`, `S birket→burkett`, `S the→a`, `S were→are`

**Deepgram** (8 errors): `D at`, `S em→atom`, `S idylls→idols`, `S birket→burkitt`, `S the→a`, `D michael`, `S angelo→michelangelo`, `S mantel→mantle`

**AssemblyAI** (9 errors): `D at`, `S em→adam`, `S birket→burkett`, `D bath`, `S the→a`, `D michael`, `S angelo→michelangelo`, `S were→are`, `S wished→wish`

**Sarvam** (12 errors): `S leighton's→layton's`, `S linnell's→linell's`, `D at`, `S em→adam`, `S birket→burkett`, `S carker→karkar`, `S in→an`, `S the→a`, `D michael`, `S angelo→michelangelo`, `S felicitous→felicitor's`, `S phases→faces`

