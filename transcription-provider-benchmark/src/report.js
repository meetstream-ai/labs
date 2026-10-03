/**
 * Step 3: score a run directory. Needs no API key and makes no network
 * calls, so anyone handed a published results/<run>/ folder can re-derive
 * every number in its table from the raw transcripts inside it.
 */
const fs = require("fs");
const path = require("path");
const { normalize, wer, clipWindow } = require("./wer");
const { transcriptText } = require("./transcript");
const { PRICES_AS_OF, audioSeconds, costOf } = require("./pricing");
const { displayName } = require("./providers");
const { textSha256 } = require("./audio");

// Bumped whenever a normalisation rule changes, so a run says which rules scored it.
const NORMALIZER = "src/wer.js normalize() v3, 2026-10-03: + money with a scale word, month-day dates (v2: spelling, contractions, compound spacing; see METHODOLOGY.md)";

/**
 * How far apart two WERs must be before the gap means anything on this many
 * reference words: a 95% band for the difference of two error rates near the
 * best one, treating words as independent. Real errors cluster, so the true
 * band is if anything wider; gaps inside it are ties.
 */
function werTieBand(bestWer, words) {
  if (!words || !Number.isFinite(bestWer)) return null;
  const p = Math.min(0.5, Math.max(bestWer, 1 / words));
  return 1.96 * Math.sqrt((2 * p * (1 - p)) / words);
}

/**
 * A path from run.json, resolved inside the run folder. A results folder may
 * come from someone else (re-scoring a published run is the point), so a
 * crafted run.json must not make scoring read or write files outside it,
 * directly ("../x") or through a symlink.
 */
function inRun(runDir, rel) {
  const root = fs.realpathSync(runDir);
  const inside = (p) => p === root || p.startsWith(root + path.sep);
  const full = path.resolve(root, String(rel ?? ""));
  if (!inside(full)) throw new Error(`${rel} is outside the run folder`);
  // Follow symlinks in the file and its folders: the real target must be inside too.
  let probe = full;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  if (!inside(fs.realpathSync(probe))) throw new Error(`${rel} leads outside the run folder (symlink)`);
  return full;
}

/** What a provider reports about the audio it was given, or null. */
function audioReported(provider, raw) {
  if (!raw || typeof raw !== "object") return null;
  const parts = [];
  if (provider === "deepgram" && raw.metadata) {
    if (typeof raw.metadata.duration === "number") parts.push(`${raw.metadata.duration.toFixed(1)} s`);
    if (raw.metadata.channels) parts.push(`${raw.metadata.channels} channel${raw.metadata.channels === 1 ? "" : "s"}`);
  }
  if (provider === "assemblyai" && typeof raw.audio_duration === "number") parts.push(`${raw.audio_duration} s`);
  if (provider === "sarvam") {
    if (raw.audio_mime) parts.push(raw.audio_mime);
    if (raw.audio_hash) parts.push(`hash ${String(raw.audio_hash).slice(0, 12)}`);
  }
  return parts.length ? parts.join(", ") : null;
}

/** The model a provider reports in its raw response, or null if it doesn't say. */
function modelReported(provider, raw) {
  if (!raw || typeof raw !== "object") return null;
  if (provider === "deepgram") {
    const models = Object.values(raw.metadata?.model_info ?? {}).map((m) => [m.name, m.version].filter(Boolean).join(" "));
    return models.length ? models.join(", ") : null;
  }
  if (provider === "assemblyai") {
    const model = raw.speech_model ?? (Array.isArray(raw.speech_models) ? raw.speech_models.join(", ") : null);
    const extra = [raw.acoustic_model, raw.language_model].filter(Boolean).join(", ");
    return model ? `${model}${extra ? ` (${extra})` : ""}` : null;
  }
  const generic = raw.model ?? raw.model_name ?? raw.model_version;
  return typeof generic === "string" ? generic : null;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const pct = (x) => (x == null ? "–" : `${(x * 100).toFixed(1)}%`);
const secs = (x) => (x == null ? "–" : `${x.toFixed(1)}s`);
const usd = (x) => (x == null ? "–" : `$${x < 0.01 ? x.toFixed(4) : x.toFixed(3)}`);
const perHour = (x) => (x == null ? "–" : `$${x.toFixed(2)}`);
// "2.6–8.6s": finished within this window; "‡" when timed separately.
const finishedWindow = (r) => r.turnaround_median_s == null ? "–"
  : `${r.turnaround_lower_s == null ? "≤" : `${r.turnaround_lower_s.toFixed(1)}–`}${secs(r.turnaround_median_s)}${r.turnaround_comparable === false ? " ‡" : ""}`;

function timingNotes(results) {
  const L = [];
  const req = results.providers.map((r) => r.transcribe_request_s).filter((x) => typeof x === "number");
  L.push(`Turnaround is the window in which each job finished, measured from sending MeetStream's transcribe request: after the last poll that still saw it processing, and by the first poll that saw it done (polled every ${results.poll_seconds}s). ` +
    `It is MeetStream's end-to-end turnaround (the request itself${req.length ? `, ${Math.min(...req).toFixed(1)}–${Math.max(...req).toFixed(1)}s here` : ""}, queueing, fetching the recording, the provider's processing), not the provider's own API latency. ` +
    "Providers whose windows overlap can't be ranked on speed.");
  if (results.providers.some((r) => r.turnaround_comparable === false)) {
    L.push("", "‡ Submitted on its own (resubmitted after a failure, or added to the run later), not alongside the others, so its turnaround isn't comparable with theirs.");
  }
  return L;
}

function score(runDir) {
  const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
  // Without a reference (a recorder-only run of unscripted talk) there is no
  // accuracy to score; the table then reports turnaround and word counts.
  const reference = run.reference ? normalize(fs.readFileSync(inRun(runDir, run.reference.file), "utf8")) : null;
  if (reference) fs.writeFileSync(path.join(runDir, "reference.normalized.txt"), reference + "\n");
  const clipSeconds = run.recording?.clip?.seconds ?? null;

  // Attempts that were replaced (resubmitted or re-run with --append) are not
  // scored, but a reader should be told they happened and why.
  const replaced = new Map();
  for (const job of run.jobs.filter((j) => j.superseded && j.status !== "Success")) {
    if (!replaced.has(job.provider)) replaced.set(job.provider, []);
    replaced.get(job.provider).push(`an earlier attempt ${job.status === "NotRun" ? "was refused" : "failed"} (${job.error ?? job.status}) and was replaced`);
  }

  const byProvider = new Map();
  for (const job of run.jobs) {
    // A failed attempt that was resubmitted, or jobs replaced by --append,
    // are kept in run.json for the record but are not what the table scores.
    if (job.superseded) continue;
    if (!byProvider.has(job.provider)) byProvider.set(job.provider, []);
    byProvider.get(job.provider).push(job);
  }

  const rows = [];
  const hypotheses = new Map(); // provider -> first scored normalised transcript
  for (const [provider, jobs] of byProvider) {
    const scored = [];
    for (const job of jobs.filter((j) => j.status === "Success" && j.transcript_file)) {
      const raw = JSON.parse(fs.readFileSync(inRun(runDir, job.transcript_file), "utf8"));
      let text;
      try {
        text = transcriptText(raw);
      } catch (err) {
        // Unreadable (an older run, or a response this code doesn't know):
        // report it as a failure rather than scoring it as silence.
        job.status = "ParseFailed";
        job.error = err.message;
        continue;
      }
      const hypothesis = normalize(text);
      if (!hypotheses.has(provider)) hypotheses.set(provider, hypothesis);
      fs.writeFileSync(inRun(runDir, job.transcript_file.replace(/\.json$/, ".normalized.txt")), hypothesis + "\n");
      // Score only what falls inside the clip; talk before or after it in
      // the room is not the provider's error. The untrimmed figure is kept.
      if (!reference) {
        scored.push({ job, words: hypothesis ? hypothesis.split(" ").length : 0 });
        continue;
      }
      const window = clipWindow(reference, hypothesis);
      scored.push({ job, window, full: wer(reference, hypothesis), result: wer(reference, window.hypothesis) });
    }

    const failures = jobs.filter((j) => j.status !== "Success" || !j.transcript_file);
    if (!scored.length) {
      rows.push({ provider, ran: false, rounds: jobs.length, reason: failures[0]?.error ?? failures[0]?.status ?? "no result" });
      continue;
    }

    const turnarounds = scored.map((s) => s.job.turnaround_s).filter((x) => typeof x === "number");
    // Turnaround is only known to a window: the job finished after the last
    // poll that still saw it processing (lower) and by the first that saw it
    // done (upper). Windows that overlap can't be ranked.
    const lowers = scored.map((s) => s.job.turnaround_lower_bound_s).filter((x) => typeof x === "number");
    const requests = scored.map((s) => s.job.request_s).filter((x) => typeof x === "number");
    // Submitted on its own (a resubmission, or --append later): not timed
    // under the same conditions as the others, so not comparable on speed.
    const separate = scored.some((s) => s.job.appended || s.job.attempt || s.job.submit_retried) && turnarounds.length > 0;
    const timing = {
      turnaround_median_s: median(turnarounds),
      turnaround_lower_s: median(lowers),
      turnaround_min_s: turnarounds.length ? Math.min(...turnarounds) : null,
      turnaround_max_s: turnarounds.length ? Math.max(...turnarounds) : null,
      transcribe_request_s: median(requests),
      turnaround_comparable: turnarounds.length > 0 && !separate,
    };
    if (!reference) {
      rows.push({
        provider,
        ran: true,
        rounds: jobs.length,
        succeeded: scored.length,
        failed_rounds: failures.map((j) => ({ round: j.round, status: j.status, error: j.error ?? null })),
        notes: [...(replaced.get(provider) ?? []), ...jobs.filter((j) => j.note).map((j) => j.note)],
        wer: null,
        words: scored[0].words,
        ...timing,
        errors: [],
        config: run.providers[provider],
      });
      continue;
    }

    // Pool the edits across rounds: total errors over total reference words.
    const sum = (k) => scored.reduce((n, s) => n + s.result[k], 0);
    const refWords = sum("referenceWords");
    const first = scored[0].result;
    rows.push({
      provider,
      ran: true,
      rounds: jobs.length,
      succeeded: scored.length,
      failed_rounds: failures.map((j) => ({ round: j.round, status: j.status, error: j.error ?? null })),
      notes: [...(replaced.get(provider) ?? []), ...jobs.filter((j) => j.note).map((j) => j.note)],
      wer: (sum("substitutions") + sum("deletions") + sum("insertions")) / refWords,
      wer_per_round: scored.map((s) => +s.result.wer.toFixed(4)),
      substitutions: sum("substitutions"),
      deletions: sum("deletions"),
      insertions: sum("insertions"),
      reference_words: refWords,
      outside_clip_words: scored.reduce((n, s) => n + s.window.before + s.window.after, 0),
      clip_found: scored.every((s) => s.window.anchored),
      wer_untrimmed: scored.reduce((n, s) => n + s.full.substitutions + s.full.deletions + s.full.insertions, 0) / refWords,
      ...timing,
      // Set below, once the billed audio length is known.
      real_time_factor: null,
      // A live run is timed from the bots leaving the call instead (see recorder.js).
      post_call_turnaround_s: scored.map((s) => s.job.turnaround_after_leaving_s).find((x) => typeof x === "number") ?? null,
      // Every error from the first successful round, so a reader can judge
      // whether they are real misrecognitions or normalisation artefacts.
      errors: first.alignment.filter((a) => a.op !== "="),
      config: run.providers[provider],
    });
  }

  // Two providers returning the very same transcript are almost certainly one
  // engine behind two names (Mia Transcribe runs on JigsawStack): say so
  // beside both, so a reader doesn't count them as two results agreeing.
  const ranRows = rows.filter((r) => r.ran && hypotheses.get(r.provider));
  for (const r of ranRows) {
    const twins = ranRows.filter((o) => o !== r && hypotheses.get(o.provider) === hypotheses.get(r.provider));
    if (twins.length) {
      r.same_output_as = twins.map((o) => o.provider);
      r.notes.push(`returned exactly the same transcript as ${twins.map((o) => displayName(o.provider)).join(", ")}, so almost certainly the same engine: count them as one result, not two that agree`);
    }
  }

  // Cost: from each provider's raw response (what it actually billed on).
  const rawOf = (job) => {
    if (!job?.raw_file) return null;
    try { return JSON.parse(fs.readFileSync(inRun(runDir, job.raw_file), "utf8")); } catch { return null; }
  };
  const rawByProvider = new Map();
  for (const [provider, jobs] of byProvider) {
    const job = jobs.find((j) => j.status === "Success" && j.raw_file);
    rawByProvider.set(provider, rawOf(job));
  }
  const billedSeconds = audioSeconds([...rawByProvider.values()]);
  // The model each provider says it ran. "nova-3" or "universal-2" in the
  // request are aliases that move over time; this is what actually ran.
  for (const row of rows.filter((r) => r.ran)) {
    row.model_reported = modelReported(row.provider, rawByProvider.get(row.provider));
    // What each provider says it received. MeetStream sends it the recording;
    // this harness can't see the bytes, only what the provider reports back.
    row.audio_reported = audioReported(row.provider, rawByProvider.get(row.provider));
    // Turnaround over the audio actually transcribed (the whole recording,
    // not just the clip), or the clip if no provider reported a length.
    const audio = billedSeconds ?? clipSeconds;
    if (reference && audio && row.turnaround_median_s != null) row.real_time_factor = row.turnaround_median_s / audio;
  }
  for (const row of rows.filter((r) => r.ran)) {
    const c = costOf(row.provider, { seconds: billedSeconds, raw: rawByProvider.get(row.provider), config: run.providers[row.provider] });
    Object.assign(row, { cost_usd: c?.cost_usd ?? null, cost_per_hour_usd: c?.per_hour_usd ?? null, cost_basis: c?.basis ?? null, cost_source: c?.source ?? null });
  }

  const rank = (r) => (reference ? r.wer ?? 0 : r.turnaround_median_s ?? Infinity);
  rows.sort((a, b) => (a.ran === b.ran ? rank(a) - rank(b) : a.ran ? -1 : 1));

  const results = {
    run_id: run.run_id,
    bot_id: run.bot.id,
    reference_words: reference ? reference.split(" ").length : null,
    wer_tie_band: reference ? werTieBand(Math.min(...rows.filter((r) => r.ran && r.wer != null).map((r) => r.wer)), reference.split(" ").length) : null,
    billed_audio_seconds: billedSeconds,
    prices_as_of: PRICES_AS_OF,
    clip_seconds: clipSeconds,
    poll_seconds: run.environment.poll_seconds,
    normalizer: NORMALIZER,
    providers: rows,
  };
  fs.writeFileSync(path.join(runDir, "results.json"), JSON.stringify(results, null, 2) + "\n");

  const markdown = renderMarkdown(run, results);
  fs.writeFileSync(path.join(runDir, "results.md"), markdown);
  return { results, markdown };
}

function renderMarkdown(run, results) {
  const L = [];
  L.push(`# Transcription provider benchmark: ${run.run_id}`, "");
  const rec = run.recording;
  const clip = rec?.clip
    ? `, clip \`${rec.clip.path.replace(/\\/g, "/")}\` (${rec.clip.seconds}s, sha256 \`${rec.clip.sha256.slice(0, 12)}…\`)`
    : rec ? ", live speech (recorder only, no clip)" : "";
  L.push(`- Recording: bot \`${run.bot.id}\`${rec?.bot_name ? ` ("${rec.bot_name}")` : ""}${rec ? ` on ${rec.meeting_platform}` : ""}${clip}`);
  L.push(run.reference
    ? `- Reference: ${results.reference_words} words after normalisation (sha256 \`${run.reference.sha256.slice(0, 12)}…\`)` +
      (run.reference.added_at ? `, added after the run on ${run.reference.added_at.slice(0, 10)}` : "")
    : "- Reference: none, so accuracy is not scored; the table reports turnaround and how many words each provider transcribed");
  L.push(`- Rounds: ${run.rounds}, all providers submitted together each round; turnaround polled every ${results.poll_seconds}s`);
  const h = run.harness_version;
  L.push(h
    ? `- Harness: version ${h.version}, commit ${h.commit ? `\`${h.commit.slice(0, 12)}\`${h.dirty ? " with uncommitted changes" : ""}` : "unknown"}`
    : "- Harness: commit not recorded (this run predates recording it)");
  const models = results.providers.filter((r) => r.ran).map((r) => `${displayName(r.provider)} ${r.model_reported ?? "(not reported)"}`);
  if (models.length) L.push(`- Models as reported by each provider: ${models.join("; ")}`);
  const audio = results.providers.filter((r) => r.ran).map((r) => `${displayName(r.provider)} ${r.audio_reported ?? "(not reported)"}`);
  if (audio.length) L.push(`- Audio as reported by each provider (MeetStream sends each the same stored recording; the harness can't see the bytes): ${audio.join("; ")}`);
  L.push(`- Method: see [METHODOLOGY.md](../../METHODOLOGY.md). Re-score offline with \`npm run score -- ${path.posix.join("results", run.run_id)}\``, "");

  if (!run.reference) {
    L.push("| Provider | Words transcribed | Turnaround (finished within) | Range over rounds | Cost | Per hour |");
    L.push("|---|---:|---:|---:|---:|---:|");
    for (const r of results.providers) {
      if (!r.ran) { L.push(`| ${displayName(r.provider)} | not run | | | | |`); continue; }
      const range = r.turnaround_min_s == null ? "–" : `${secs(r.turnaround_min_s)}–${secs(r.turnaround_max_s)}`;
      L.push(`| ${displayName(r.provider)} | ${r.words} | ${finishedWindow(r)} | ${range} | ${usd(r.cost_usd)} | ${perHour(r.cost_per_hour_usd)} |`);
    }
    L.push("", ...timingNotes(results), "", "Each provider's transcript is in `transcripts/`.");
  } else {
  L.push("| Provider | WER | Sub | Del | Ins | Outside clip | Turnaround (finished within) | Range over rounds | × real time (of billed audio) | Cost | Per hour |");
  L.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of results.providers) {
    if (!r.ran) {
      L.push(`| ${displayName(r.provider)} | not run | | | | | | | | | |`);
      continue;
    }
    const range = r.turnaround_min_s == null ? "–" : `${secs(r.turnaround_min_s)}–${secs(r.turnaround_max_s)}`;
    const turnaround = r.turnaround_median_s == null && r.post_call_turnaround_s != null
      ? `${secs(r.post_call_turnaround_s)} after call †`
      : finishedWindow(r);
    const rtf = r.real_time_factor == null ? "–" : `${r.real_time_factor.toFixed(2)}×`;
    const outside = r.clip_found ? `${r.outside_clip_words} word${r.outside_clip_words === 1 ? "" : "s"} (untrimmed WER ${pct(r.wer_untrimmed)})` : "clip not found, nothing cut";
    L.push(`| ${displayName(r.provider)} | ${pct(r.wer)} | ${r.substitutions} | ${r.deletions} | ${r.insertions} | ${outside} | ${turnaround} | ${range} | ${rtf} | ${usd(r.cost_usd)} | ${perHour(r.cost_per_hour_usd)} |`);
  }
  L.push("");
  L.push("WER counts only words inside the clip: anything a provider transcribed before the clip started or after it ended (talk in the room while the bots joined) is cut first and shown under Outside clip. See METHODOLOGY.md for the rule.", "");
  if (results.providers.some((r) => r.turnaround_median_s == null && r.post_call_turnaround_s != null)) {
    L.push("† Ran live on the recording bot because MeetStream's re-transcribe endpoint would not run it, so it is timed from the bots leaving the call. That includes MeetStream's post-call media processing, which the other turnarounds (timed from a re-transcribe request on an already-processed recording) do not.", "");
  }
  L.push("WER is pooled over all successful rounds." + (results.wer_tie_band != null
    ? ` On ${results.reference_words} reference words, WER gaps under ${(results.wer_tie_band * 100).toFixed(1)} points are within sampling noise (95%, treating words as independent; real errors cluster, so the true band is wider): treat them as ties.`
    : ""), "", ...timingNotes(results));

  }

  const priced = results.providers.filter((r) => r.ran && r.cost_basis);
  if (priced.length) {
    L.push("", `**Cost** is transcription only, at each provider's published rate on ${results.prices_as_of}, for ${results.billed_audio_seconds != null ? `${(results.billed_audio_seconds / 60).toFixed(2)} min of billed audio` : "the billed audio (length unknown: no provider reported it)"}. MeetStream's bot fee applies whichever provider is used and is not included. Rates: ${priced.map((r) => `${displayName(r.provider)} ${r.cost_basis}`).join("; ")}.`);
  }

  const notRun = results.providers.filter((r) => !r.ran || r.failed_rounds?.length);
  if (notRun.length) {
    L.push("", "## Not run or partly failed", "");
    for (const r of notRun) {
      if (!r.ran) L.push(`- **${displayName(r.provider)}**: ${r.reason}`);
      else for (const f of r.failed_rounds) L.push(`- **${displayName(r.provider)}** round ${f.round}: ${f.status}${f.error ? ` (${f.error})` : ""}`);
    }
  }

  const noted = results.providers.filter((r) => r.notes?.length);
  if (noted.length) {
    L.push("", "## Notes", "");
    for (const r of noted) for (const n of r.notes) L.push(`- **${displayName(r.provider)}**: ${n}`);
  }

  if (!run.reference) return L.join("\n") + "\n";

  L.push("", "## Errors by provider (first successful round)", "");
  L.push("`S ref→hyp` substitution, `D ref` deletion (missed word), `I hyp` insertion. Normalised text for each provider is in `transcripts/*.normalized.txt`.", "");
  for (const r of results.providers.filter((x) => x.ran)) {
    const shown = r.errors.slice(0, 40).map((e) =>
      e.op === "S" ? `S ${e.ref}→${e.hyp}` : e.op === "D" ? `D ${e.ref}` : `I ${e.hyp}`
    );
    L.push(`**${displayName(r.provider)}** (${r.errors.length} errors)${shown.length ? ": " + shown.map((s) => `\`${s}\``).join(", ") : ""}${r.errors.length > 40 ? ", …" : ""}`, "");
  }
  return L.join("\n") + "\n";
}

/**
 * Adds a reference to a run that finished without one (people talking: what
 * was said is only known afterwards), then scores it. The reference is copied
 * into the run folder and marked as added later; a run that already has one
 * keeps it.
 */
function addReference(runDir, referencePath) {
  const runPath = path.join(runDir, "run.json");
  const run = JSON.parse(fs.readFileSync(runPath, "utf8"));
  if (run.reference) throw new Error(`${runDir} already has a reference; its accuracy is already scored.`);
  const text = fs.readFileSync(referencePath, "utf8");
  if (!normalize(text)) throw new Error("The reference is empty.");
  fs.writeFileSync(path.join(runDir, "reference.txt"), text);
  run.reference = {
    file: "reference.txt",
    source: path.basename(referencePath),
    sha256: textSha256(text, { isText: true }),
    sha256_line_endings: "lf",
    added_at: new Date().toISOString(),
  };
  fs.writeFileSync(runPath, JSON.stringify(run, null, 2) + "\n");
  return score(runDir);
}

module.exports = { score, addReference, inRun };
