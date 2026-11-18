import pytest
from conftest import FakeResponse, FakeSession

from voice_agent.client import MeetStreamClient, MeetStreamError

BASE_URL = "https://api.meetstream.ai/api/v1"


def make_client(responses):
    session = FakeSession(responses)
    return MeetStreamClient("ms_test_key", BASE_URL, session), session


def test_create_agent_config_posts_to_mia_and_returns_the_id():
    client, session = make_client([FakeResponse(200, {"agent_config_id": "agent-123"})])

    agent_config_id = client.create_agent_config({"agent_name": "Assistant"})

    assert agent_config_id == "agent-123"
    call = session.calls[0]
    assert call["method"] == "POST"
    assert call["url"] == BASE_URL + "/mia"
    assert call["json"] == {"agent_name": "Assistant"}
    assert call["timeout"] == 30


def test_every_call_sends_the_token_auth_header():
    client, session = make_client([FakeResponse(200, {"agent_config_id": "a"})])
    client.create_agent_config({})
    assert session.calls[0]["headers"]["Authorization"] == "Token ms_test_key"


def test_create_agent_config_without_an_id_is_an_error():
    client, _ = make_client([FakeResponse(200, {"message": "ok"})])
    with pytest.raises(MeetStreamError, match="agent_config_id"):
        client.create_agent_config({})


def test_create_bot_posts_the_payload_and_returns_the_bot():
    client, session = make_client([FakeResponse(201, {"bot_id": "bot-1", "status": "Active"})])

    bot = client.create_bot({"meeting_link": "https://meet.google.com/abc"})

    assert bot["bot_id"] == "bot-1"
    assert session.calls[0]["url"] == BASE_URL + "/bots/create_bot"
    assert session.calls[0]["method"] == "POST"


def test_get_bot_status_uses_get():
    client, session = make_client([FakeResponse(200, {"status": "Recording"})])
    assert client.get_bot_status("bot-1")["status"] == "Recording"
    assert session.calls[0] == {
        "method": "GET",
        "url": BASE_URL + "/bots/bot-1/status",
        "headers": session.calls[0]["headers"],
        "json": None,
        "timeout": 30,
    }


def test_remove_bot_uses_get_per_the_api_spec():
    client, session = make_client([FakeResponse(200, {"message": "removed"})])
    client.remove_bot("bot-1")
    assert session.calls[0]["method"] == "GET"
    assert session.calls[0]["url"] == BASE_URL + "/bots/bot-1/remove_bot"


@pytest.mark.parametrize("status_code", [400, 404, 429, 500])
def test_non_2xx_raises_with_status_and_body(status_code):
    client, _ = make_client([FakeResponse(status_code, text="something went wrong")])
    with pytest.raises(MeetStreamError) as exc:
        client.create_bot({})
    assert exc.value.status_code == status_code
    assert "something went wrong" in str(exc.value)


def test_401_explains_the_api_key():
    client, _ = make_client([FakeResponse(401, text="unauthorized")])
    with pytest.raises(MeetStreamError, match="MEETSTREAM_API_KEY"):
        client.create_bot({})


def test_empty_body_is_returned_as_an_empty_dict():
    client, _ = make_client([FakeResponse(204, text="")])
    assert client.remove_bot("bot-1") == {}


def test_base_url_trailing_slash_does_not_double_up():
    session = FakeSession([FakeResponse(200, {"status": "Done"})])
    client = MeetStreamClient("k", BASE_URL + "/", session)
    client.get_bot_status("bot-1")
    assert session.calls[0]["url"] == BASE_URL + "/bots/bot-1/status"
