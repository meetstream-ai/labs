from chat_responder.sanitize import TRUNCATION_MARKER, clean_inbound, clean_outbound


def test_inbound_strips_control_characters():
    assert clean_inbound("!help\x00\x07 now", 100) == "!help now"


def test_inbound_collapses_newlines_and_whitespace():
    assert clean_inbound("  !help \n\t  please  ", 100) == "!help please"


def test_inbound_strips_invisible_characters():
    # Zero-width space inside the keyword must not create a hidden command,
    # and a bidi override must not survive into our logs.
    assert clean_inbound("!he​lp", 100) == "!help"
    assert "‮" not in clean_inbound("hi ‮txet", 100)


def test_inbound_truncates():
    assert clean_inbound("a" * 500, 10) == "a" * 10


def test_inbound_handles_non_strings():
    assert clean_inbound(None, 10) == ""
    assert clean_inbound(42, 10) == ""


def test_outbound_keeps_newlines_but_drops_control_chars():
    assert clean_outbound("line one\nline two\x00", 100) == "line one\nline two"


def test_outbound_collapses_blank_line_runs():
    assert clean_outbound("a\n\n\n\n\nb", 100) == "a\n\nb"


def test_outbound_truncates_on_a_line_boundary():
    text = "\n".join("item {}".format(i) for i in range(50))
    result = clean_outbound(text, 120)
    assert len(result) <= 120
    assert result.endswith(TRUNCATION_MARKER)
    assert "item 0" in result
