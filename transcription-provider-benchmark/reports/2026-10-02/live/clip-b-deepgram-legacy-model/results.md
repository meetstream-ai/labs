# Live provider comparison

- Source: file `../transcription-provider-benchmark/reports/2026-10-02/inputs/clip-b.wav` (16000 Hz, resampled to 48 kHz), 122.55s of audio, sent to every provider at once in real time
- Latency: time from the end of a phrase's audio to its final transcript arriving (median / p90 over phrases), and from the last audio to the last final

| Provider | WER | Sub / Del / Ins | Latency (median) | Latency (p90) | After end of audio | Finals |
|---|---:|---:|---:|---:|---:|---:|
| assemblyai | 5.1% | 13 / 1 / 0 | 0.43s | 0.47s | 0.23s | 17 |
| deepgram | 15.4% | 30 / 7 / 5 | 0.34s | 0.60s | 0.21s | 36 |

## Errors by provider

**assemblyai** (14 errors): `S ruggedo→rugado`, `D there`, `S is→there's`, `S nomes→gnomes`, `S kaliko→calico`, `S kaliko→calico`, `S kaliko→calico`, `S ann→anne`, `S kaliko→calico`, `S kaliko→calico`, `S ruggedo→brigado`, `S kaliko→calico`, `S ruggedo's→rugedo's`, `S ruggedo→rugedo`

**deepgram** (42 errors): `S raps→wraps`, `S opened→open`, `D fled`, `S in→flood`, `S ruggedo→rugged`, `D but`, `I but`, `D i`, `S said→since`, `D there`, `S is→there's`, `S dominions→dominion`, `S nomes→norms`, `S returned→return`, `S kaliko→calico`, `S shaggy→s`, `S metal→middle`, `S domed→dome`, `S in→and`, `I dominion`, `I rep`, `S dominions→reply`, `S replied→call`, `S kaliko→rep`, `S kaliko→call`, `S hesitated→hesitate`, `S ann→anne`, `I or`, `S confessed→confess`, `D kaliko`, `S kaliko→chemical`, `D as`, `S ruggedo→b`, `S kaliko→calico`, `D in`, `S ruggedo's→reg`, `I crab`, `S crown→around`, `S the→to`, `S scepter→sc`, …

