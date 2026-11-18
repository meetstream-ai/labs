from __future__ import annotations

import io
import json
import types

import pytest

from talk_time import cli


def run(args, tmp_path, extra=None):
    out = io.StringIO()
    destination = tmp_path / "report.json"
    argv = list(args) + ["--json-out", str(destination), "--env-file", str(tmp_path / "absent.env")]
    code = cli.main(argv + (extra or []), out=out)
    payload = json.loads(destination.read_text(encoding="utf-8")) if destination.is_file() else None
    return code, out.getvalue(), payload


def test_end_to_end_on_a_byte_offset_timeline(fixtures, tmp_path):
    code, text, payload = run([str(fixtures / "timeline_bytes.json")], tmp_path)
    assert code == 0

    speakers = {speaker["speaker"]: speaker for speaker in payload["speakers"]}
    assert set(speakers) == {"Alice", "Bob", "Chi"}
    assert speakers["Alice"]["total_seconds"] == pytest.approx(25.0)
    assert speakers["Alice"]["turns"] == 2
    assert speakers["Alice"]["longest_stretch_seconds"] == pytest.approx(20.0)
    assert speakers["Bob"]["total_seconds"] == pytest.approx(25.0)
    assert speakers["Chi"]["total_seconds"] == pytest.approx(5.0)
    assert speakers["Chi"]["share_percent"] == pytest.approx(9.09, abs=0.01)
    # Shares are rounded to 6 dp in the JSON, so they add to 1.0 within rounding.
    assert sum(speaker["share"] for speaker in payload["speakers"]) == pytest.approx(1.0, abs=1e-5)

    assert payload["totals"]["total_speech_seconds"] == pytest.approx(55.0)
    assert payload["totals"]["meeting_span_seconds"] == pytest.approx(60.0)
    assert payload["totals"]["unattributed_seconds"] == pytest.approx(1.0)
    assert payload["units"]["timeline_basis"] == "bytes"
    assert payload["units"]["seconds_are_derived"] is True
    assert payload["source"]["type"] == "file"
    assert payload["parsing"]["chunks_read"] == 7

    assert "Alice" in text and "0:00:25" in text
    assert "JSON written to" in text


def test_wrapped_seconds_timeline(fixtures, tmp_path):
    code, _, payload = run([str(fixtures / "timeline_wrapped_seconds.json")], tmp_path)
    assert code == 0
    assert payload["units"]["seconds_are_derived"] is False
    speakers = {speaker["speaker"]: speaker for speaker in payload["speakers"]}
    assert speakers["Alice"]["total_seconds"] == pytest.approx(16.5)
    assert speakers["Alice"]["turns"] == 2
    assert speakers["Bob"]["total_seconds"] == pytest.approx(7.5)


def test_sample_rate_override_rescales_seconds(fixtures, tmp_path):
    code, _, payload = run(
        [str(fixtures / "timeline_bytes.json"), "--sample-rate", "24000"], tmp_path
    )
    assert code == 0
    # Half the bytes per second means every duration doubles.
    speakers = {speaker["speaker"]: speaker for speaker in payload["speakers"]}
    assert speakers["Alice"]["total_seconds"] == pytest.approx(50.0)
    assert speakers["Alice"]["share_percent"] == pytest.approx(45.45, abs=0.01)


def test_turn_gap_override_changes_turn_counts(fixtures, tmp_path):
    code, _, payload = run([str(fixtures / "timeline_bytes.json"), "--turn-gap", "30"], tmp_path)
    assert code == 0
    speakers = {speaker["speaker"]: speaker for speaker in payload["speakers"]}
    assert speakers["Alice"]["turns"] == 1


def test_quiet_writes_json_without_printing(fixtures, tmp_path):
    code, text, payload = run([str(fixtures / "timeline_bytes.json"), "--quiet"], tmp_path)
    assert code == 0
    assert text == ""
    assert payload["speakers"]


def test_reads_stdin(fixtures, tmp_path, monkeypatch):
    body = (fixtures / "timeline_bytes.json").read_bytes()
    monkeypatch.setattr(cli.sys, "stdin", types.SimpleNamespace(buffer=io.BytesIO(body)))
    code, _, payload = run(["-"], tmp_path)
    assert code == 0
    assert payload["source"] == {"type": "stdin"}
    assert len(payload["speakers"]) == 3


def test_bot_id_uses_the_api_client(fixtures, tmp_path, monkeypatch):
    calls = {}

    def fake_open(bot_id, config, **kwargs):
        calls["bot_id"] = bot_id
        return io.BytesIO((fixtures / "timeline_bytes.json").read_bytes())

    monkeypatch.setattr(cli, "open_speaker_timeline", fake_open)
    code, _, payload = run(["--bot-id", "bot-abc"], tmp_path)
    assert code == 0
    assert calls["bot_id"] == "bot-abc"
    assert payload["bot_id"] == "bot-abc"
    assert payload["source"] == {"type": "api", "bot_id": "bot-abc"}


def test_long_meeting_timeline_is_read_from_the_link(fixtures, tmp_path, monkeypatch):
    """The long-meeting shape: 200, no chunks inline, a link to them instead."""
    envelope = (fixtures / "timeline_linked.json").read_bytes()
    linked = (fixtures / "timeline_bytes.json").read_bytes()
    opened = []

    monkeypatch.setattr(cli, "open_speaker_timeline", lambda bot_id, config, **kw: io.BytesIO(envelope))

    def fake_link(url, **kwargs):
        opened.append(url)
        return io.BytesIO(linked)

    monkeypatch.setattr(cli, "open_timeline_link", fake_link)

    code, _, payload = run(["--bot-id", "bot-abc"], tmp_path)
    assert code == 0
    assert opened == ["https://media.example.com/timelines/2f0f3f4c.json?X-Amz-Signature=deadbeef"]
    assert {speaker["speaker"] for speaker in payload["speakers"]} == {"Alice", "Bob", "Chi"}
    assert payload["parsing"]["chunks_read"] == 7
    # The link is recorded without its signature.
    assert payload["source"]["timeline_links"] == ["https://media.example.com/timelines/2f0f3f4c.json"]
    assert payload["source"]["bot_id"] == "bot-abc"


def test_linked_timeline_in_parts_is_folded_in_order(tmp_path, monkeypatch, write_timeline):
    envelope = write_timeline(
        {
            "speaker_timeline_parts": [
                "https://media.example.com/t/part-1.json",
                "https://media.example.com/t/part-2.json",
            ]
        }
    )
    parts = {
        "https://media.example.com/t/part-1.json": [
            {"speaker": "Alice", "start_byte": 0, "end_byte": 960000}
        ],
        "https://media.example.com/t/part-2.json": [
            {"speaker": "Bob", "start_byte": 960000, "end_byte": 1920000},
            {"speaker": "Alice", "start_byte": 1920000, "end_byte": 2880000},
        ],
    }
    monkeypatch.setattr(
        cli, "open_timeline_link", lambda url, **kw: io.BytesIO(json.dumps(parts[url]).encode("utf-8"))
    )

    code, _, payload = run([str(envelope)], tmp_path)
    assert code == 0
    speakers = {speaker["speaker"]: speaker for speaker in payload["speakers"]}
    assert speakers["Alice"]["total_seconds"] == pytest.approx(20.0)
    assert speakers["Bob"]["total_seconds"] == pytest.approx(10.0)
    assert payload["parsing"]["chunks_read"] == 3
    assert payload["source"]["timeline_links"] == list(parts)


def test_no_follow_links_fails_instead_of_fetching(fixtures, tmp_path, monkeypatch, capsys):
    def never(url, **kwargs):  # pragma: no cover - must never run
        raise AssertionError("followed {}".format(url))

    monkeypatch.setattr(cli, "open_timeline_link", never)
    code, _, _ = run([str(fixtures / "timeline_linked.json"), "--no-follow-links"], tmp_path)
    assert code == 2
    assert "--no-follow-links" in capsys.readouterr().err


def test_a_link_that_leads_to_more_links_stops(tmp_path, monkeypatch, capsys, write_timeline):
    envelope = write_timeline({"speaker_timeline_url": "https://media.example.com/t/a.json"})
    monkeypatch.setattr(
        cli,
        "open_timeline_link",
        lambda url, **kw: io.BytesIO(b'{"speaker_timeline_url": "https://media.example.com/t/b.json"}'),
    )
    code, _, _ = run([str(envelope)], tmp_path)
    assert code == 2
    assert "holds no chunks either" in capsys.readouterr().err


def test_bot_id_without_a_key_fails_cleanly(tmp_path, capsys):
    code, _, _ = run(["--bot-id", "bot-abc"], tmp_path)
    assert code == 2
    assert "MEETSTREAM_API_KEY" in capsys.readouterr().err


def test_missing_file_fails_cleanly(tmp_path, capsys):
    code, _, _ = run([str(tmp_path / "nope.json")], tmp_path)
    assert code == 2
    assert "no such timeline file" in capsys.readouterr().err


def test_unreadable_json_fails_cleanly(tmp_path, capsys):
    bad = tmp_path / "bad.json"
    bad.write_text('{"message": "Transcript is still being processed."}', encoding="utf-8")
    code, _, _ = run([str(bad)], tmp_path)
    assert code == 2
    assert "no array of timeline chunks" in capsys.readouterr().err


@pytest.mark.parametrize("args", [[], ["x.json", "--bot-id", "b"]])
def test_needs_exactly_one_source(args, tmp_path):
    with pytest.raises(SystemExit) as excinfo:
        run(args, tmp_path)
    assert excinfo.value.code == 2


def test_negative_turn_gap_is_rejected(fixtures, tmp_path, capsys):
    code, _, _ = run([str(fixtures / "timeline_bytes.json"), "--turn-gap", "-1"], tmp_path)
    assert code == 2
    assert "--turn-gap" in capsys.readouterr().err


def test_env_file_supplies_settings(fixtures, tmp_path):
    env_file = tmp_path / "custom.env"
    env_file.write_text("TALK_TIME_TURN_GAP_SECONDS=30\n", encoding="utf-8")
    destination = tmp_path / "from-env.json"
    code = cli.main(
        [
            str(fixtures / "timeline_bytes.json"),
            "--env-file",
            str(env_file),
            "--json-out",
            str(destination),
            "--quiet",
        ],
        out=io.StringIO(),
    )
    assert code == 0
    payload = json.loads(destination.read_text(encoding="utf-8"))
    assert payload["settings"]["turn_gap_seconds"] == 30.0
    assert {speaker["speaker"]: speaker["turns"] for speaker in payload["speakers"]}["Alice"] == 1


def test_output_path_comes_from_env_when_not_passed(fixtures, tmp_path, monkeypatch):
    env_file = tmp_path / "custom.env"
    env_file.write_text("TALK_TIME_OUTPUT=env-report.json\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    code = cli.main(
        [str(fixtures / "timeline_bytes.json"), "--env-file", str(env_file), "--quiet"],
        out=io.StringIO(),
    )
    assert code == 0
    assert (tmp_path / "env-report.json").is_file()
