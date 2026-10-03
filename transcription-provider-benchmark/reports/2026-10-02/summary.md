### Runs

| # | Test | Platform | Run | Reference words | Poll | Harness |
|---|---|---|---|---:|---:|---:|
| 1 | Sample clip, recording A (Test 1) | Google Meet | `2026-09-28T18-08-58Z` | 420 | 5 s | not recorded |
| 2 | Sample clip, recording B | Google Meet | `2026-10-02T19-10-28Z` | 420 | 1 s | `d1e29bc` |
| 3 | Sample clip, recording C | Google Meet | `2026-10-02T19-14-43Z` | 420 | 1 s | `d1e29bc` |
| 4 | Sample clip, recording D | Google Meet | `2026-10-02T19-18-58Z` | 420 | 1 s | `d1e29bc` |
| 5 | Typed script, read by Windows text-to-speech | Google Meet | `2026-10-02T19-21-07Z` | 169 | 1 s | `d1e29bc` |
| 6 | Own audio file (clip B) | Google Meet | `2026-10-02T19-24-13Z` | 272 | 1 s | `d1e29bc` |
| 7 | A person reading aloud (reference added after) | Google Meet | `2026-10-02T19-25-58Z` | 126 | 1 s | `d1e29bc` |
| 8 | Sample clip on Microsoft Teams | Microsoft Teams | `2026-10-02T19-50-03Z` | 420 | 1 s | `9dba41b` |
| 9 | Sample clip on Zoom | Zoom | `2026-10-02T20-42-29Z` | 420 | 1 s | `7ad01ba` |

### Accuracy, the sample clip (6 recordings)

| Provider | Pooled WER | Range over runs | Runs | Words |
|---|---:|---:|---:|---:|
| Mia Transcribe | 1.9% | 1.2%–2.9% | 6 | 2520 |
| JigsawStack | 1.9% | 1.2%–2.9% | 6 | 2520 |
| AssemblyAI | 2.2% | 1.9%–2.6% | 6 | 2520 |
| Deepgram | 2.7% | 1.9%–3.6% | 6 | 2520 |
| Sarvam | 3.7% | 2.9%–5.0% | 6 | 2520 |

Pooled over 6 runs and 2520 reference words: gaps under 0.7 points are within sampling noise (95%, treating words as independent).

### Accuracy, every scored run

| Provider | Pooled WER | Range over runs | Runs | Words |
|---|---:|---:|---:|---:|
| Mia Transcribe | 1.8% | 0.0%–2.9% | 9 | 3087 |
| JigsawStack | 1.9% | 0.0%–3.7% | 9 | 3087 |
| AssemblyAI | 2.2% | 0.0%–3.7% | 9 | 3087 |
| Deepgram | 2.9% | 1.8%–5.9% | 9 | 3087 |
| Sarvam | 3.8% | 0.0%–7.4% | 9 | 3087 |

Pooled over 9 runs and 3087 reference words: gaps under 0.7 points are within sampling noise (95%, treating words as independent).

### The sample clip on each platform

| Provider | Google Meet (4) | Microsoft Teams (1) | Zoom (1) |
|---|---:|---:|---:|
| Mia Transcribe | 2.1% | 1.4% | 1.2% |
| JigsawStack | 2.1% | 1.4% | 1.2% |
| AssemblyAI | 2.3% | 2.1% | 2.1% |
| Deepgram | 3.0% | 2.4% | 1.9% |
| Sarvam | 4.0% | 3.3% | 2.9% |

Pooled WER per platform; the number of recordings is in brackets. One recording on a platform is a single sample: its spread is the same as between recordings on one platform (see Accuracy by run).

### Accuracy by run

| Provider | 1. sample | 2. sample | 3. sample | 4. sample | 5. script | 6. clip-b | 7. talk | 8. sample | 9. sample |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Mia Transcribe | 1.4% | 2.9% | 2.9% | 1.4% | 0.0% | 2.9% | 0.8% | 1.4% | 1.2% |
| JigsawStack | 1.4% | 2.9% | 2.9% | 1.4% | 0.0% | 3.7% | 0.8% | 1.4% | 1.2% |
| AssemblyAI | 2.6% | 2.4% | 2.1% | 1.9% | 0.0% | 3.7% | 0.8% | 2.1% | 2.1% |
| Deepgram | 3.1% | 2.9% | 3.6% | 2.6% | 1.8% | 5.9% | 2.4% | 2.4% | 1.9% |
| Sarvam | 3.8% | 3.8% | 5.0% | 3.6% | 0.0% | 7.4% | 2.4% | 3.3% | 2.9% |

### Turnaround, 8 runs polled every second

| Provider | Median | Fastest run | Slowest run | Runs |
|---|---:|---:|---:|---:|
| Deepgram | 5.7 s | 3.1 s | 28.3 s | 8 |
| JigsawStack | 6.0 s | 5.0 s | 12.5 s | 8 |
| Mia Transcribe | 7.4 s | 4.2 s | 22.6 s | 8 |
| AssemblyAI | 10.7 s | 9.3 s | 14.7 s | 8 |
| Sarvam | 18.6 s | 14.4 s | 31.1 s | 8 |

Each value is the poll that first saw the job done (the upper end of its window; the job finished up to 1 s earlier), measured from MeetStream's transcribe request.

### Turnaround by run (finished within)

| Provider | 2. sample | 3. sample | 4. sample | 5. script | 6. clip-b | 7. talk | 8. sample | 9. sample |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Mia Transcribe | 5.6–7.6 | 20.8–22.6 | 11.0–12.7 | 3.1–5.0 | 2.5–4.2 | 5.0–6.6 | 5.4–7.3 | 7.4–9.3 |
| JigsawStack | 5.6–7.6 | 3.1–5.0 | 3.3–5.2 | 3.1–5.0 | 9.7–11.3 | 5.0–6.6 | 10.6–12.5 | 4.0–5.5 |
| AssemblyAI | 13.1–14.7 | 11.8–14.0 | 7.1–9.3 | 11.5–13.7 | 7.7–9.7 | 8.6–10.2 | 9.1–10.6 | 9.3–10.9 |
| Deepgram | 4.1–5.6 | 10.2–11.8 | 7.1–9.3 | 1.5–3.1 | 4.2–5.7 | 1.5–3.1 | 26.1–28.3 | 2.5–4.0 |
| Sarvam | 16.3–18.2 | 26.0–27.7 | 12.7–14.4 | 28.8–31.1 | 17.3–19.0 | 20.7–22.4 | 14.0–15.6 | 14.6–16.2 |

### Cost

| Provider | Published rate, per hour of audio |
|---|---:|
| JigsawStack | $0.03 |
| Mia Transcribe | $0.10 |
| AssemblyAI | $0.17 |
| Deepgram | $0.26 |
| Sarvam | $0.47 |

Transcription spend for all 9 runs together: $0.477 (MeetStream bot fees not included).
