# Transcription provider benchmark: 2026-10-02T19-10-28Z

- Recording: bot `849a0e50-8d94-4061-9390-ef4b0a460c89` on meet.google.com, clip `sample/clip.wav` (191.435s, sha256 `f2d2ec68f98c…`)
- Reference: 420 words after normalisation (sha256 `aed990bbd046…`)
- Rounds: 1, all providers submitted together each round; turnaround polled every 1s
- Harness: version 1.0.2, commit `d1e29bc06149`
- Models as reported by each provider: AssemblyAI universal-2 (assemblyai_default, assemblyai_default); Mia Transcribe (not reported); Deepgram general-nova-3 2025-07-31.0; JigsawStack (not reported); Sarvam (not reported)
- Audio as reported by each provider (MeetStream sends each the same stored recording; the harness can't see the bytes): AssemblyAI 221 s; Mia Transcribe (not reported); Deepgram 220.6 s, 1 channel; JigsawStack (not reported); Sarvam audio/wav, hash 231f68235fcc
- Method: see [METHODOLOGY.md](../../METHODOLOGY.md). Re-score offline with `npm run score -- results/2026-10-02T19-10-28Z`

| Provider | WER | Sub | Del | Ins | Outside clip | Turnaround (finished within) | Range over rounds | × real time (of billed audio) | Cost | Per hour |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| AssemblyAI | 2.4% | 7 | 3 | 0 | 0 words (untrimmed WER 2.4%) | 13.1–14.7s | 14.7s–14.7s | 0.07× | $0.010 | $0.17 |
| Mia Transcribe | 2.9% | 9 | 3 | 0 | 0 words (untrimmed WER 2.9%) | 5.6–7.6s | 7.6s–7.6s | 0.03× | $0.0061 | $0.10 |
| Deepgram | 2.9% | 9 | 2 | 1 | 0 words (untrimmed WER 2.9%) | 4.1–5.6s | 5.6s–5.6s | 0.03× | $0.016 | $0.26 |
| JigsawStack | 2.9% | 9 | 3 | 0 | 0 words (untrimmed WER 2.9%) | 5.6–7.6s | 7.6s–7.6s | 0.03× | $0.0022 | $0.04 |
| Sarvam | 3.8% | 13 | 3 | 0 | 0 words (untrimmed WER 3.8%) | 16.3–18.2s | 18.2s–18.2s | 0.08× | $0.029 | $0.47 |

WER counts only words inside the clip: anything a provider transcribed before the clip started or after it ended (talk in the room while the bots joined) is cut first and shown under Outside clip. See METHODOLOGY.md for the rule.

WER is pooled over all successful rounds. On 420 reference words, WER gaps under 2.1 points are within sampling noise (95%, treating words as independent; real errors cluster, so the true band is wider): treat them as ties.

Turnaround is the window in which each job finished, measured from sending MeetStream's transcribe request: after the last poll that still saw it processing, and by the first poll that saw it done (polled every 1s). It is MeetStream's end-to-end turnaround (the request itself, 0.7–2.5s here, queueing, fetching the recording, the provider's processing), not the provider's own API latency. Providers whose windows overlap can't be ranked on speed.

**Cost** is transcription only, at each provider's published rate on 2026-09-28, for 3.68 min of billed audio. MeetStream's bot fee applies whichever provider is used and is not included. Rates: AssemblyAI $0.15/hr Universal-2 + $0.02/hr speaker labels; Mia Transcribe $0.10/hr (MeetStream transcription add-on); Deepgram $0.0043/min (Nova-3 pre-recorded); JigsawStack $0.99 per 1M tokens (from the response's own usage); Sarvam ₹45/hr batch with diarization, at ₹96.16/$.

## Notes

- **Mia Transcribe**: returned exactly the same transcript as JigsawStack, so almost certainly the same engine: count them as one result, not two that agree
- **JigsawStack**: returned exactly the same transcript as Mia Transcribe, so almost certainly the same engine: count them as one result, not two that agree

## Errors by provider (first successful round)

`S ref→hyp` substitution, `D ref` deletion (missed word), `I hyp` insertion. Normalised text for each provider is in `transcripts/*.normalized.txt`.

**AssemblyAI** (10 errors): `S matter→madder`, `D at`, `S em→adam`, `S birket→burkett`, `S the→a`, `D michael`, `S angelo→michelangelo`, `D mantel`, `S board→mantleboard`, `S were→are`

**Mia Transcribe** (12 errors): `S rocky→wauke`, `S linnell's→lynyll's`, `D up`, `S guards→upgards`, `D at`, `S em→adam`, `S jingo→djingo`, `S birket→burkett`, `S the→a`, `D michael`, `S angelo→michelangelo`, `S were→are`

**Deepgram** (12 errors): `S leighton's→layton's`, `S rocky→wachie`, `D at`, `S em→atom`, `S idylls→idols`, `S birket→burkitt`, `S shampooer→shampoo`, `S the→a`, `D michael`, `S angelo→michelangelo`, `S mantel→mantle`, `I because`

**JigsawStack** (12 errors): `S rocky→wauke`, `S linnell's→lynyll's`, `D up`, `S guards→upgards`, `D at`, `S em→adam`, `S jingo→djingo`, `S birket→burkett`, `S the→a`, `D michael`, `S angelo→michelangelo`, `S were→are`

**Sarvam** (16 errors): `S leighton's→layton's`, `S rocky→waki`, `S linnell's→linell's`, `D at`, `S em→adam`, `S birket→burkett`, `S carker→karkar`, `S in→an`, `D finish`, `S in→finishing`, `S the→a`, `D michael`, `S angelo→michelangelo`, `S felicitous→felicitor's`, `S tupper→topper`, `S quilter→krulter`

