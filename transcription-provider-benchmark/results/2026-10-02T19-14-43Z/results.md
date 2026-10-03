# Transcription provider benchmark: 2026-10-02T19-14-43Z

- Recording: bot `52f907b0-f378-4f1d-9d98-8553733f1e25` on meet.google.com, clip `sample/clip.wav` (191.435s, sha256 `f2d2ec68f98c…`)
- Reference: 420 words after normalisation (sha256 `aed990bbd046…`)
- Rounds: 1, all providers submitted together each round; turnaround polled every 1s
- Harness: version 1.0.2, commit `d1e29bc06149`
- Models as reported by each provider: AssemblyAI universal-2 (assemblyai_default, assemblyai_default); Mia Transcribe (not reported); JigsawStack (not reported); Deepgram general-nova-3 2025-07-31.0; Sarvam (not reported)
- Audio as reported by each provider (MeetStream sends each the same stored recording; the harness can't see the bytes): AssemblyAI 218 s; Mia Transcribe (not reported); JigsawStack (not reported); Deepgram 217.9 s, 1 channel; Sarvam audio/wav, hash 60a5a7220ce1
- Method: see [METHODOLOGY.md](../../METHODOLOGY.md). Re-score offline with `npm run score -- results/2026-10-02T19-14-43Z`

| Provider | WER | Sub | Del | Ins | Outside clip | Turnaround (finished within) | Range over rounds | × real time (of billed audio) | Cost | Per hour |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| AssemblyAI | 2.1% | 7 | 2 | 0 | 1 word (untrimmed WER 2.4%) | 11.8–14.0s | 14.0s–14.0s | 0.06× | $0.010 | $0.17 |
| Mia Transcribe | 2.9% | 10 | 2 | 0 | 0 words (untrimmed WER 2.9%) | 20.8–22.6s | 22.6s–22.6s | 0.10× | $0.0061 | $0.10 |
| JigsawStack | 2.9% | 10 | 2 | 0 | 0 words (untrimmed WER 2.9%) | 3.1–5.0s | 5.0s–5.0s | 0.02× | $0.0020 | $0.03 |
| Deepgram | 3.6% | 11 | 3 | 1 | 0 words (untrimmed WER 3.6%) | 10.2–11.8s | 11.8s–11.8s | 0.05× | $0.016 | $0.26 |
| Sarvam | 5.0% | 16 | 3 | 2 | 0 words (untrimmed WER 5.0%) | 26.0–27.7s | 27.7s–27.7s | 0.13× | $0.028 | $0.47 |

WER counts only words inside the clip: anything a provider transcribed before the clip started or after it ended (talk in the room while the bots joined) is cut first and shown under Outside clip. See METHODOLOGY.md for the rule.

WER is pooled over all successful rounds. On 420 reference words, WER gaps under 2.0 points are within sampling noise (95%, treating words as independent; real errors cluster, so the true band is wider): treat them as ties.

Turnaround is the window in which each job finished, measured from sending MeetStream's transcribe request: after the last poll that still saw it processing, and by the first poll that saw it done (polled every 1s). It is MeetStream's end-to-end turnaround (the request itself, 0.7–1.5s here, queueing, fetching the recording, the provider's processing), not the provider's own API latency. Providers whose windows overlap can't be ranked on speed.

**Cost** is transcription only, at each provider's published rate on 2026-09-28, for 3.63 min of billed audio. MeetStream's bot fee applies whichever provider is used and is not included. Rates: AssemblyAI $0.15/hr Universal-2 + $0.02/hr speaker labels; Mia Transcribe $0.10/hr (MeetStream transcription add-on); JigsawStack $0.99 per 1M tokens (from the response's own usage); Deepgram $0.0043/min (Nova-3 pre-recorded); Sarvam ₹45/hr batch with diarization, at ₹96.16/$.

## Notes

- **Mia Transcribe**: returned exactly the same transcript as JigsawStack, so almost certainly the same engine: count them as one result, not two that agree
- **JigsawStack**: returned exactly the same transcript as Mia Transcribe, so almost certainly the same engine: count them as one result, not two that agree

## Errors by provider (first successful round)

`S ref→hyp` substitution, `D ref` deletion (missed word), `I hyp` insertion. Normalised text for each provider is in `transcripts/*.normalized.txt`.

**AssemblyAI** (9 errors): `S matter→manner`, `S rocky→waki`, `D at`, `S em→atom`, `S birket→burke`, `S the→a`, `D michael`, `S angelo→michelangelo`, `S were→are`

**Mia Transcribe** (12 errors): `S matter→manner`, `S rocky→waki`, `S ithaca→ithaka`, `S linnell's→lynyll's`, `D up`, `S guards→upgards`, `D at`, `S em→adam`, `S jingo→djingo`, `S birket→burkett`, `S the→a`, `S were→are`

**JigsawStack** (12 errors): `S matter→manner`, `S rocky→waki`, `S ithaca→ithaka`, `S linnell's→lynyll's`, `D up`, `S guards→upgards`, `D at`, `S em→adam`, `S jingo→djingo`, `S birket→burkett`, `S the→a`, `S were→are`

**Deepgram** (15 errors): `S drawn→gone`, `S grave→great`, `D sir`, `S frederick→surfer`, `S rocky→wachie`, `D at`, `S em→atom`, `S idylls→idols`, `I reading`, `S birket→burkitt`, `S the→a`, `D michael`, `S angelo→michelangelo`, `S mantel→mantle`, `S were→are`

**Sarvam** (21 errors): `S quilter's→coulter's`, `S drawn→run`, `S grave→great`, `S leighton's→layton's`, `I on`, `S of→the`, `S rocky→waki`, `S linnell's→linell's`, `D at`, `S em→adam`, `I rohini`, `S birket→burkett`, `S carker→karkar`, `S in→an`, `D finish`, `S in→finishing`, `S the→a`, `D michael`, `S angelo→michelangelo`, `S felicitous→felicitor's`, `S phases→faces`

