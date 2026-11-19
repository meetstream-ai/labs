import io

from live_captions.captions import UNKNOWN_SPEAKER, CaptionPrinter, parse_chunk


def chunk(**overrides):
    payload = {
        "bot_id": "bot-1",
        "speakerName": "Alice",
        "transcript": "Hello everyone.",
        "timestamp": "2026-11-18T10:21:43.681Z",
        "is_final": True,
    }
    payload.update(overrides)
    return payload


def test_final_chunk_prints_a_speaker_labelled_line(printer, output):
    line = printer.handle_chunk(chunk())

    assert "Alice: Hello everyone." in line
    assert output.getvalue().strip().endswith("Alice: Hello everyone.")
    assert output.getvalue().startswith("[")


def test_timestamp_is_rendered_as_a_clock(printer):
    line = printer.handle_chunk(chunk())

    clock = line[1:9]
    assert len(clock.split(":")) == 3
    assert all(part.isdigit() for part in clock.split(":"))


def test_chunk_without_a_timestamp_still_renders(printer):
    line = printer.handle_chunk(chunk(timestamp=None))

    assert "Alice: Hello everyone." in line


def test_unattributed_audio_is_labelled_unknown(printer):
    line = printer.handle_chunk(chunk(speakerName="NoSpeaker"))

    assert "%s: Hello everyone." % UNKNOWN_SPEAKER in line


def test_missing_speaker_is_labelled_unknown(printer):
    line = printer.handle_chunk(chunk(speakerName=None))

    assert UNKNOWN_SPEAKER in line


def test_interim_chunks_do_not_print_final_lines(printer, output):
    assert printer.handle_chunk(chunk(is_final=False)) is None
    assert output.getvalue() == ""


def test_interim_chunks_overwrite_in_place_on_a_terminal():
    stream = io.StringIO()
    printer = CaptionPrinter(stream=stream, color=False, show_interim=True)

    printer.handle_chunk(chunk(transcript="Hello", is_final=False))
    printer.handle_chunk(chunk(transcript="Hello everyone", is_final=False))
    printer.handle_chunk(chunk())

    written = stream.getvalue()
    assert written.count("\r\x1b[2K") == 3  # two interims plus the clear before the final
    assert written.endswith("Alice: Hello everyone.\n")


def test_repeated_final_chunk_is_printed_once(printer, output):
    printer.handle_chunk(chunk())
    printer.handle_chunk(chunk())

    assert output.getvalue().count("Hello everyone.") == 1


def test_same_text_from_a_different_speaker_is_not_deduped(printer, output):
    printer.handle_chunk(chunk())
    printer.handle_chunk(chunk(speakerName="Bob"))

    assert output.getvalue().count("Hello everyone.") == 2


def test_empty_and_malformed_chunks_are_ignored(printer, output):
    for payload in ({}, chunk(transcript=""), chunk(transcript="   "), chunk(transcript=None)):
        assert printer.handle_chunk(payload) is None
    assert output.getvalue() == ""


def test_colour_is_emitted_only_when_enabled():
    plain, coloured = io.StringIO(), io.StringIO()

    CaptionPrinter(stream=plain, color=False, show_interim=False).handle_chunk(chunk())
    CaptionPrinter(stream=coloured, color=True, show_interim=False).handle_chunk(chunk())

    assert "\x1b[" not in plain.getvalue()
    assert "\x1b[" in coloured.getvalue()


def test_each_speaker_gets_a_distinct_colour():
    stream = io.StringIO()
    printer = CaptionPrinter(stream=stream, color=True, show_interim=False)

    printer.handle_chunk(chunk(speakerName="Alice"))
    printer.handle_chunk(chunk(speakerName="Bob", transcript="Hi."))
    printer.handle_chunk(chunk(speakerName="Alice", transcript="Again."))

    lines = stream.getvalue().splitlines()
    alice_colour = lines[0].split("Alice")[0][-5:]
    bob_colour = lines[1].split("Bob")[0][-5:]
    assert alice_colour != bob_colour
    assert lines[2].split("Alice")[0][-5:] == alice_colour


def test_status_lines_are_printed(printer, output):
    printer.status("bot joined the meeting")

    assert "bot joined the meeting" in output.getvalue()


def test_parse_chunk_normalises_fields():
    caption = parse_chunk(chunk(transcript="  spaced  ", is_final=False))

    assert caption.speaker == "Alice"
    assert caption.text == "spaced"
    assert caption.is_final is False


def test_control_characters_from_the_meeting_are_dropped():
    caption = parse_chunk({"speakerName": "Eve\x1b]0;owned\x07\x1b[2J", "transcript": "hi\x1b[31m there\r"})
    assert caption.speaker == "Eve]0;owned[2J"
    assert caption.text == "hi[31m there"
    assert "\x1b" not in caption.speaker + caption.text


def test_a_name_that_is_only_control_characters_is_unknown():
    caption = parse_chunk({"speakerName": "\x1b\x07", "transcript": "hello"})
    assert caption.speaker == UNKNOWN_SPEAKER
