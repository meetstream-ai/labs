"""
Independent re-score of a benchmark run with the tools most ASR papers use:
jiwer for WER and OpenAI Whisper's English text normaliser.

It shares no code with the Node scorer. It reads the raw transcripts the API
returned (results/<run>/transcripts/*.json) and the reference, and computes
WER from scratch, so a reader who distrusts src/wer.js can check the table
against a scorer MeetStream did not write.

    pip install -r scripts/requirements.txt
    python scripts/score_jiwer.py results/<run>
"""
import json
import sys
from pathlib import Path

import jiwer
from whisper_normalizer.english import EnglishTextNormalizer


def transcript_text(data):
    """Same two response shapes src/transcript.js understands."""
    if isinstance(data, str):
        return data
    if isinstance(data, dict) and isinstance(data.get("message"), list):
        return " ".join(
            " ".join(w.get("text") or w.get("word") or "" for w in entry.get("words") or [])
            for entry in data["message"]
        )
    if isinstance(data, dict):
        data = data.get("transcript") or data.get("data") or []
    segments = []
    for seg in data or []:
        text = seg.get("transcript") or seg.get("text")
        if not isinstance(text, str):
            text = " ".join(w.get("punctuated_word") or w.get("word") or w.get("text") or "" for w in seg.get("words") or [])
        start = seg.get("start_time", seg.get("start"))
        segments.append((start, text))
    if all(isinstance(s, (int, float)) for s, _ in segments):
        segments.sort(key=lambda s: s[0])
    return " ".join(t for _, t in segments)


def clip_window(reference, hypothesis, anchor=3):
    """The rule src/wer.js clipWindow() applies, on jiwer's own alignment:
    cut what was transcribed before the first / after the last run of
    `anchor` correct words, keeping as many hypothesis words at each edge as
    the reference has there."""
    ref, hyp = reference.split(), hypothesis.split()
    runs = [c for c in jiwer.process_words(reference, hypothesis).alignments[0]
            if c.type == "equal" and c.ref_end_idx - c.ref_start_idx >= anchor]
    if not runs:
        return hypothesis
    first, last = runs[0], runs[-1]
    start = max(0, first.hyp_start_idx - first.ref_start_idx)
    end = min(len(hyp), last.hyp_end_idx + (len(ref) - last.ref_end_idx))
    return " ".join(hyp[start:end])


def main(run_dir):
    run_dir = Path(run_dir)
    run = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
    normalise = EnglishTextNormalizer()
    reference = normalise((run_dir / run["reference"]["file"]).read_text(encoding="utf-8"))

    by_provider = {}
    for job in run["jobs"]:
        if job.get("status") != "Success" or not job.get("transcript_file"):
            continue
        data = json.loads((run_dir / job["transcript_file"]).read_text(encoding="utf-8"))
        hypothesis = clip_window(reference, normalise(transcript_text(data)))
        out = jiwer.process_words(reference, hypothesis)
        agg = by_provider.setdefault(job["provider"], [0, 0, 0, 0])
        agg[0] += out.substitutions
        agg[1] += out.deletions
        agg[2] += out.insertions
        agg[3] += out.hits + out.substitutions + out.deletions  # reference words

    print(f"jiwer {jiwer.__version__ if hasattr(jiwer, '__version__') else ''} + Whisper EnglishTextNormalizer, run {run['run_id']}\n")
    print("| Provider | WER | Sub | Del | Ins |")
    print("|---|---:|---:|---:|---:|")
    for provider, (s, d, i, n) in sorted(by_provider.items(), key=lambda kv: sum(kv[1][:3]) / kv[1][3]):
        print(f"| {provider} | {100 * (s + d + i) / n:.1f}% | {s} | {d} | {i} |")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
