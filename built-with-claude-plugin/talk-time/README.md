# talk-time

Per-speaker talk-time for a finished MeetStream bot, from its speaker timeline:
total seconds, share of the meeting, number of turns and longest uninterrupted
stretch - printed as a table and written as JSON.

## Install

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
cp .env.example .env     # fill in only what you need
```

## Use

```bash
# A timeline saved from GET /bots/{bot_id}/get_speaker_timeline
talk-time timeline.json --json-out talk-time.json

# Or straight from the API (needs MEETSTREAM_API_KEY in .env)
talk-time --bot-id 2f0f3f4c-... --json-out talk-time.json

# Or piped in
curl ... | talk-time -
```

```
Speaker             Talk time   Share  Turns  Longest
------------------  ---------  ------  -----  -------
Alice                 0:00:25   45.5%      2  0:00:20
Bob                   0:00:25   45.5%      2  0:00:20
Chi                   0:00:05    9.1%      1  0:00:05
------------------  ---------  ------  -----  -------
TOTAL (3 speakers)    0:00:55  100.0%      5
```

The JSON report carries the same numbers plus `units`, `settings` and `parsing`
blocks, so a reader can tell how the figures were produced.

## The one thing to know about the numbers

`get_speaker_timeline` returns **byte offsets into the recorded audio, not
seconds**. So:

* **Shares and turn counts are exact** - they are ratios and counts of chunks.
* **Seconds are derived** by dividing the byte offsets by `bytes_per_second`,
  which comes from `TALK_TIME_SAMPLE_RATE`, `TALK_TIME_SAMPLE_WIDTH` and
  `TALK_TIME_CHANNELS`. The defaults (48000 / 2 / 1 = 96000 B/s) match
  MeetStream's raw audio. If the recording is in a different format, every
  duration scales by the same wrong factor - set the right values in `.env` or
  pass `--sample-rate`.

Every JSON report says which basis was used (`units.timeline_basis`) and whether
the seconds are derived (`units.seconds_are_derived`), so a derived figure is
never mistaken for a measured one.

Timelines that already carry times (seconds, milliseconds or ISO timestamps) are
detected from the field names and used as-is. `--unit` forces the
interpretation when the field names lie.

## Definitions

| Column | Meaning |
|---|---|
| Talk time | The union of that speaker's chunks. Overlapping or repeated chunks count once. |
| Share | Talk time over the sum of everyone's talk time. When people talk over each other the shares still add to 100%, and total talk time exceeds the meeting span. |
| Turns | Runs of that speaker's chunks separated by less than `TALK_TIME_TURN_GAP_SECONDS` (default 1.0 s). Raw timelines chunk every ~250 ms, so without this merge every chunk would read as its own turn. Tune it with `--turn-gap`. |
| Longest | The longest such run, measured end-to-start: how long they held the floor without a pause longer than the gap threshold. |

Audio the API could not attribute to a participant (`NoSpeaker`) is reported
separately rather than counted as a speaker - see `TALK_TIME_UNATTRIBUTED_LABELS`.

Chunks that cannot be used (no speaker, no timing, ending before they start) are
counted in `parsing` and called out under the table, never silently dropped.

## Long meetings

A long meeting does not come back as chunks. `get_speaker_timeline` still
answers 200, but the body is an envelope carrying one or more links to the
timeline JSON - so the tool fetches those links and folds them in order, as if
they had arrived inline. The links are pre-signed, so no API key is sent with
them, only `https` is followed, and the JSON report records each link without
its query string (`source.timeline_links`) rather than storing the signature.
A link that leads only to more links is an error, not a loop. Pass
`--no-follow-links` to make the tool stop at the envelope instead of fetching.

If the body carries no chunks and no link, the error now quotes the envelope's
top-level keys and whatever message the API sent, instead of only saying no
chunks were found.

The timeline is parsed as a stream and folded in one pass, so memory is
proportional to the number of speakers, not the length of the meeting. An
eight-hour meeting (115k chunks, 7.9 MB of JSON) runs in about 2 seconds and
under 20 MB of RSS on a laptop. `tests/test_scale.py` holds that line: it asserts
peak allocation stays under 2 MB while a four-hour timeline streams past.

## Tests

```bash
.venv/bin/python -m pytest
```

No test touches the network: the API client is exercised through a fake opener.

## Run against the local mock (no API key, no meeting)

[`../mock-meetstream`](../mock-meetstream) is a small offline stand-in for the MeetStream API. It answers with the same request and response shapes, and it plays a short meeting (lifecycle webhooks, live transcript, post-call files) when asked. `mock_e2e.py` starts the mock, runs this app against it, and prints PASS or FAIL.

```bash
python3 -m venv .venv && .venv/bin/pip install -U pip && .venv/bin/pip install -e ".[dev]"
python3 mock_e2e.py
```
