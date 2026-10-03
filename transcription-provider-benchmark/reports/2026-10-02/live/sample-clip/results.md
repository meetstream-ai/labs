# Live provider comparison

- Source: file `../transcription-provider-benchmark/sample/clip.wav` (16000 Hz, resampled to 48 kHz), 191.435s of audio, sent to every provider at once in real time
- Latency: time from the end of a phrase's audio to its final transcript arriving (median / p90 over phrases), and from the last audio to the last final

| Provider | WER | Sub / Del / Ins | Latency (median) | Latency (p90) | After end of audio | Finals |
|---|---:|---:|---:|---:|---:|---:|
| assemblyai | 1.2% | 4 / 1 / 0 | 0.43s | 0.52s | 0.31s | 21 |
| deepgram | 3.6% | 11 / 3 / 1 | 0.36s | 1.56s | 0.08s | 55 |

## Errors by provider

**assemblyai** (5 errors): `S frederick→frederic`, `S birket→burkett`, `D michael`, `S angelo→michelangelo`, `S were→are`

**deepgram** (15 errors): `I simile`, `S similes→is`, `S leighton's→layton's`, `D at`, `S em→atom`, `S idylls→idols`, `S as→a`, `S birket→burkett`, `S finish→finnish`, `D what`, `S the→a`, `D michael`, `S angelo→michelangelo`, `S mantel→mantle`, `S were→are`

