# Live provider comparison

- Source: file `../transcription-provider-benchmark/sample/clip.wav` (16000 Hz, resampled to 48 kHz), 191.435s of audio, sent to every provider at once in real time
- Latency: time from the end of a phrase's audio to its final transcript arriving (median / p90 over phrases), and from the last audio to the last final

| Provider | WER | Sub / Del / Ins | Latency (median) | Latency (p90) | After end of audio | Finals |
|---|---:|---:|---:|---:|---:|---:|
| assemblyai | 1.4% | 4 / 2 / 0 | 0.43s | 0.45s | 0.31s | 21 |
| deepgram | 14.5% | 47 / 10 / 4 | 0.30s | 1.44s | 0.00s | 53 |

## Errors by provider

**assemblyai** (6 errors): `S frederick→frederic`, `S birket→burkett`, `D michael`, `S angelo→michelangelo`, `S were→are`, `D answered`

**deepgram** (61 errors): `S quilter→quilt`, `I are`, `I and`, `S quilter's→quilt`, `S matter→matters`, `S similes→sim`, `S and→in`, `S mind→mine`, `D grave`, `S doubts→grieve`, `S whether→dose`, `S sir→with`, `S frederick→her`, `S leighton's→latent`, `S ithaca→is`, `S linnell's→len`, `D at`, `S em→adam`, `S mason's→mason`, `I it`, `S idylls→will`, `S jingo→jin`, `I burke`, `S birket→at`, `S foster's→foster`, `S carker→car`, `S collier→collie`, `S sitter→consider`, `S on→in`, `S shampooer→shampoo`, `S in→and`, `S quilter→quilt`, `D lucidity`, `S fact→effect`, `D etchings`, `S they→etching`, `S are→there`, `S laments→lament`, `S the→a`, `D in`, …

