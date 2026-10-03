# Live provider comparison

- Source: file `../transcription-provider-benchmark/reports/2026-10-02/inputs/clip-b.wav` (16000 Hz, resampled to 48 kHz), 122.55s of audio, sent to every provider at once in real time
- Latency: time from the end of a phrase's audio to its final transcript arriving (median / p90 over phrases), and from the last audio to the last final

| Provider | WER | Sub / Del / Ins | Latency (median) | Latency (p90) | After end of audio | Finals |
|---|---:|---:|---:|---:|---:|---:|
| assemblyai | 5.1% | 13 / 1 / 0 | 0.43s | 0.55s | 0.22s | 17 |
| deepgram | 6.3% | 14 / 3 / 0 | 0.28s | 0.47s | 0.10s | 38 |

## Errors by provider

**assemblyai** (14 errors): `S ruggedo→rugado`, `D there`, `S is→there's`, `S nomes→gnomes`, `S kaliko→calico`, `S kaliko→calico`, `S kaliko→calico`, `S ann→anne`, `S kaliko→calico`, `S kaliko→calico`, `S ruggedo→brigado`, `S kaliko→calico`, `S ruggedo's→rugedo's`, `S ruggedo→rugedo`

**deepgram** (17 errors): `D fled`, `S in→flooded`, `D there`, `S is→there's`, `S nomes→gnomes`, `S kaliko→calico`, `S metal→meadow`, `S kaliko→calico`, `S kaliko→calico`, `S ann→anne`, `D or`, `S kaliko→calico`, `S kaliko→calico`, `S ruggedo→brigado`, `S kaliko→calico`, `S ruggedo's→rigideaux's`, `S ruggedo→ragiddo`

