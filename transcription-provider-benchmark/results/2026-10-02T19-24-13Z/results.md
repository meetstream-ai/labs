# Transcription provider benchmark: 2026-10-02T19-24-13Z

- Recording: bot `9a9b71e8-e3eb-4586-bb12-ae87bdeabeb5` on meet.google.com, clip `reports/2026-10-02/inputs/clip-b.wav` (122.55s, sha256 `4b5e2d8583fb…`)
- Reference: 272 words after normalisation (sha256 `13c75e3064f7…`)
- Rounds: 1, all providers submitted together each round; turnaround polled every 1s
- Harness: version 1.0.2, commit `d1e29bc06149`
- Models as reported by each provider: Mia Transcribe (not reported); AssemblyAI universal-2 (assemblyai_default, assemblyai_default); JigsawStack (not reported); Deepgram general-nova-3 2025-07-31.0; Sarvam (not reported)
- Audio as reported by each provider (MeetStream sends each the same stored recording; the harness can't see the bytes): Mia Transcribe (not reported); AssemblyAI 150 s; JigsawStack (not reported); Deepgram 149.2 s, 1 channel; Sarvam audio/wav, hash db637368fd57
- Method: see [METHODOLOGY.md](../../METHODOLOGY.md). Re-score offline with `npm run score -- results/2026-10-02T19-24-13Z`

| Provider | WER | Sub | Del | Ins | Outside clip | Turnaround (finished within) | Range over rounds | × real time (of billed audio) | Cost | Per hour |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Mia Transcribe | 2.9% | 8 | 0 | 0 | 0 words (untrimmed WER 2.9%) | 2.5–4.2s | 4.2s–4.2s | 0.03× | $0.0041 | $0.10 |
| AssemblyAI | 3.7% | 9 | 1 | 0 | 0 words (untrimmed WER 3.7%) | 7.7–9.7s | 9.7s–9.7s | 0.06× | $0.0070 | $0.17 |
| JigsawStack | 3.7% | 10 | 0 | 0 | 0 words (untrimmed WER 3.7%) | 9.7–11.3s | 11.3s–11.3s | 0.08× | $0.0026 | $0.06 |
| Deepgram | 5.9% | 14 | 2 | 0 | 0 words (untrimmed WER 5.9%) | 4.2–5.7s | 5.7s–5.7s | 0.04× | $0.011 | $0.26 |
| Sarvam | 7.4% | 19 | 1 | 0 | 0 words (untrimmed WER 7.4%) | 17.3–19.0s | 19.0s–19.0s | 0.13× | $0.019 | $0.47 |

WER counts only words inside the clip: anything a provider transcribed before the clip started or after it ended (talk in the room while the bots joined) is cut first and shown under Outside clip. See METHODOLOGY.md for the rule.

WER is pooled over all successful rounds. On 272 reference words, WER gaps under 2.8 points are within sampling noise (95%, treating words as independent; real errors cluster, so the true band is wider): treat them as ties.

Turnaround is the window in which each job finished, measured from sending MeetStream's transcribe request: after the last poll that still saw it processing, and by the first poll that saw it done (polled every 1s). It is MeetStream's end-to-end turnaround (the request itself, 1.1–2.5s here, queueing, fetching the recording, the provider's processing), not the provider's own API latency. Providers whose windows overlap can't be ranked on speed.

**Cost** is transcription only, at each provider's published rate on 2026-09-28, for 2.49 min of billed audio. MeetStream's bot fee applies whichever provider is used and is not included. Rates: Mia Transcribe $0.10/hr (MeetStream transcription add-on); AssemblyAI $0.15/hr Universal-2 + $0.02/hr speaker labels; JigsawStack $0.99 per 1M tokens (from the response's own usage); Deepgram $0.0043/min (Nova-3 pre-recorded); Sarvam ₹45/hr batch with diarization, at ₹96.16/$.

## Errors by provider (first successful round)

`S ref→hyp` substitution, `D ref` deletion (missed word), `I hyp` insertion. Normalised text for each provider is in `transcripts/*.normalized.txt`.

**Mia Transcribe** (8 errors): `S has→is`, `S nomes→gnomes`, `S kaliko→calico`, `S kaliko→calico`, `S kaliko→calico`, `S kaliko→calico`, `S kaliko→calico`, `S kaliko→kalico`

**AssemblyAI** (10 errors): `D there`, `S is→there's`, `S nomes→gnomes`, `S kaliko→calico`, `S kaliko→calico`, `S kaliko→calico`, `S kaliko→calico`, `S kaliko→calico`, `S ruggedo→riggedo`, `S kaliko→calico`

**JigsawStack** (10 errors): `S has→is`, `S nomes→gnomes`, `S kaliko→calico`, `S kaliko→calico`, `S kaliko→calico`, `S ann→anne`, `S kaliko→calico`, `S kaliko→calico`, `S ruggedo→bergadot`, `S kaliko→kalico`

**Deepgram** (16 errors): `D has`, `S fled→is`, `S in→flooded`, `D there`, `S is→there's`, `S nomes→gnomes`, `S kaliko→calico`, `S kaliko→calico`, `S kaliko→calico`, `S ann→anne`, `S kaliko→calico`, `S kaliko→calico`, `S ruggedo→brigado`, `S kaliko→calico`, `S ruggedo's→ragiddo's`, `S ruggedo→ragiddo`

**Sarvam** (20 errors): `S has→is`, `S fled→flooded`, `S in→with`, `S ruggedo→rigado`, `S he→it`, `D there`, `S is→there's`, `S nomes→gnomes`, `S returned→return`, `S kaliko→calico`, `S metal→middle`, `S kaliko→calico`, `S kaliko→kalgo`, `S ann→anne`, `S kaliko→calico`, `S kaliko→calico`, `S ruggedo→brigado`, `S kaliko→calico`, `S ruggedo's→rigido's`, `S ruggedo→rigido`

