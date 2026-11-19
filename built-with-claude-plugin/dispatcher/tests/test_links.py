from __future__ import annotations

import pytest
from conftest import MEET, TEAMS, ZOOM

from dispatcher.links import classify, parse_links


@pytest.mark.parametrize(
    "url,platform",
    [
        (MEET, "google_meet"),
        ("https://meet.google.com/ABC-DEFG-HIJ", "google_meet"),
        (ZOOM, "zoom"),
        ("https://zoom.us/j/123456789", "zoom"),
        ("https://agency.zoomgov.com/w/9876543210", "zoom"),
        (TEAMS, "teams"),
    ],
)
def test_classify_accepts_real_links(url, platform):
    assert classify(url) == (platform, None)


@pytest.mark.parametrize(
    "url,expected_in_reason",
    [
        ("meet.google.com/abc-defg-hij", "http(s)"),
        ("http://meet.google.com/abc-defg-hij", "https"),
        ("https://meet.google.com/abcdefghij", "not a recognised"),
        ("https://example.com/my-meeting", "not a recognised"),
        ("https://zoom.us/j/12", "not a recognised"),
        ("https://meet.google.com/lookup/abcdef", "lookup"),
        ("https://zoom.us/my/jane.doe", "personal-room"),
    ],
)
def test_classify_rejects_with_a_reason(url, expected_in_reason):
    platform, reason = classify(url)
    assert platform is None
    assert expected_in_reason in reason


def test_parse_links_skips_comments_and_blanks():
    links, rejected = parse_links(["# a comment", "", "   ", MEET])
    assert rejected == []
    assert [link.url for link in links] == [MEET]
    assert links[0].line_number == 4


def test_parse_links_mixed_platforms_keeps_input_order():
    links, rejected = parse_links([ZOOM, MEET, TEAMS])
    assert [link.platform for link in links] == ["zoom", "google_meet", "teams"]
    assert rejected == []


def test_parse_links_reads_per_meeting_bot_name():
    links, _ = parse_links(["{0}, Board Call Notetaker".format(MEET), ZOOM])
    assert links[0].bot_name == "Board Call Notetaker"
    assert links[1].bot_name is None


def test_parse_links_rejects_bad_lines_with_line_numbers():
    links, rejected = parse_links([MEET, "https://example.com/not-a-meeting"])
    assert [link.url for link in links] == [MEET]
    assert len(rejected) == 1
    assert rejected[0].line_number == 2
    assert "not a recognised" in rejected[0].reason


def test_parse_links_drops_duplicates_by_default():
    links, rejected = parse_links([MEET, ZOOM, MEET])
    assert [link.url for link in links] == [MEET, ZOOM]
    assert len(rejected) == 1
    assert rejected[0].line_number == 3
    assert "duplicate of line 1" in rejected[0].reason


def test_parse_links_keeps_duplicates_when_allowed():
    links, rejected = parse_links([MEET, MEET], allow_duplicates=True)
    assert len(links) == 2
    assert rejected == []


@pytest.mark.parametrize(
    "url",
    [
        "https://teams.live.com/meet/9876543210?p=abc",
        "https://teams.microsoft.com/meet/2345678901234?p=abc",
    ],
)
def test_classify_accepts_other_teams_link_forms(url):
    assert classify(url) == ("teams", None)
