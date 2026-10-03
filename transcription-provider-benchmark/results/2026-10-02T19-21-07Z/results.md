# Transcription provider benchmark: 2026-10-02T19-21-07Z

- Recording: bot `097a4531-3c78-4b0c-848e-53471eb6e6c2` on meet.google.com, clip `reports/2026-10-02/inputs/tts-speech.wav` (67.483s, sha256 `e793050abf11…`)
- Reference: 169 words after normalisation (sha256 `d4039bf86c07…`)
- Rounds: 1, all providers submitted together each round; turnaround polled every 1s
- Harness: version 1.0.2, commit `d1e29bc06149`
- Models as reported by each provider: Mia Transcribe (not reported); AssemblyAI universal-2 (assemblyai_default, assemblyai_default); Sarvam (not reported); JigsawStack (not reported); Deepgram general-nova-3 2025-07-31.0
- Audio as reported by each provider (MeetStream sends each the same stored recording; the harness can't see the bytes): Mia Transcribe (not reported); AssemblyAI 96 s; Sarvam audio/wav, hash 526648a1356d; JigsawStack (not reported); Deepgram 95.7 s, 1 channel
- Method: see [METHODOLOGY.md](../../METHODOLOGY.md). Re-score offline with `npm run score -- results/2026-10-02T19-21-07Z`

| Provider | WER | Sub | Del | Ins | Outside clip | Turnaround (finished within) | Range over rounds | × real time (of billed audio) | Cost | Per hour |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Mia Transcribe | 0.0% | 0 | 0 | 0 | 0 words (untrimmed WER 0.0%) | 3.1–5.0s | 5.0s–5.0s | 0.05× | $0.0027 | $0.10 |
| AssemblyAI | 0.0% | 0 | 0 | 0 | 2 words (untrimmed WER 1.2%) | 11.5–13.7s | 13.7s–13.7s | 0.14× | $0.0045 | $0.17 |
| Sarvam | 0.0% | 0 | 0 | 0 | 0 words (untrimmed WER 0.0%) | 28.8–31.1s | 31.1s–31.1s | 0.33× | $0.012 | $0.47 |
| JigsawStack | 0.0% | 0 | 0 | 0 | 0 words (untrimmed WER 0.0%) | 3.1–5.0s | 5.0s–5.0s | 0.05× | $0.0016 | $0.06 |
| Deepgram | 1.8% | 2 | 0 | 1 | 0 words (untrimmed WER 1.8%) | 1.5–3.1s | 3.1s–3.1s | 0.03× | $0.0069 | $0.26 |

WER counts only words inside the clip: anything a provider transcribed before the clip started or after it ended (talk in the room while the bots joined) is cut first and shown under Outside clip. See METHODOLOGY.md for the rule.

WER is pooled over all successful rounds. On 169 reference words, WER gaps under 1.6 points are within sampling noise (95%, treating words as independent; real errors cluster, so the true band is wider): treat them as ties.

Turnaround is the window in which each job finished, measured from sending MeetStream's transcribe request: after the last poll that still saw it processing, and by the first poll that saw it done (polled every 1s). It is MeetStream's end-to-end turnaround (the request itself, 0.6–1.5s here, queueing, fetching the recording, the provider's processing), not the provider's own API latency. Providers whose windows overlap can't be ranked on speed.

**Cost** is transcription only, at each provider's published rate on 2026-09-28, for 1.60 min of billed audio. MeetStream's bot fee applies whichever provider is used and is not included. Rates: Mia Transcribe $0.10/hr (MeetStream transcription add-on); AssemblyAI $0.15/hr Universal-2 + $0.02/hr speaker labels; Sarvam ₹45/hr batch with diarization, at ₹96.16/$; JigsawStack $0.99 per 1M tokens (from the response's own usage); Deepgram $0.0043/min (Nova-3 pre-recorded).

## Notes

- **Mia Transcribe**: returned exactly the same transcript as Sarvam, JigsawStack, so almost certainly the same engine: count them as one result, not two that agree
- **Sarvam**: returned exactly the same transcript as Mia Transcribe, JigsawStack, so almost certainly the same engine: count them as one result, not two that agree
- **JigsawStack**: returned exactly the same transcript as Mia Transcribe, Sarvam, so almost certainly the same engine: count them as one result, not two that agree

## Errors by provider (first successful round)

`S ref→hyp` substitution, `D ref` deletion (missed word), `I hyp` insertion. Normalised text for each provider is in `transcripts/*.normalized.txt`.

**Mia Transcribe** (0 errors)

**AssemblyAI** (0 errors)

**Sarvam** (0 errors)

**JigsawStack** (0 errors)

**Deepgram** (3 errors): `S point→million`, `I hundred`, `S million→thousand`

