import pytest

from chat_responder.agenda import OVERSIZE_NOTE, AgendaError, load_agenda


def test_reads_the_file(agenda_file):
    assert "1. Intros" in load_agenda(agenda_file, 8192, 2000)


def test_missing_file(tmp_path):
    with pytest.raises(AgendaError):
        load_agenda(tmp_path / "nope.md", 8192, 2000)


def test_directory_is_not_a_file(tmp_path):
    with pytest.raises(AgendaError):
        load_agenda(tmp_path, 8192, 2000)


def test_empty_file(tmp_path):
    path = tmp_path / "agenda.md"
    path.write_text("   \n\n", encoding="utf-8")
    with pytest.raises(AgendaError):
        load_agenda(path, 8192, 2000)


def test_large_file_is_capped(tmp_path):
    path = tmp_path / "agenda.md"
    path.write_text("\n".join("item {}".format(i) for i in range(5000)), encoding="utf-8")
    result = load_agenda(path, 200, 2000)
    assert len(result.encode("utf-8")) <= 200 + len(OVERSIZE_NOTE) + 1
    assert result.endswith(OVERSIZE_NOTE)


def test_invalid_utf8_does_not_raise(tmp_path):
    path = tmp_path / "agenda.md"
    path.write_bytes(b"Agenda\n\xff\xfe binary\n")
    assert "Agenda" in load_agenda(path, 8192, 2000)


def test_control_characters_in_the_file_are_stripped(tmp_path):
    path = tmp_path / "agenda.md"
    path.write_text("Agenda\x00\x07\nItem one\n", encoding="utf-8")
    result = load_agenda(path, 8192, 2000)
    assert "\x00" not in result and "\x07" not in result
