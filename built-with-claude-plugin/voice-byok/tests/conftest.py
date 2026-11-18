import json as jsonlib

import pytest

from voice_agent.config import Settings

BASE_ENV = {
    "MEETSTREAM_API_KEY": "ms_test_key",
    "OPENAI_API_KEY": "sk-test-openai",
    "DEEPGRAM_API_KEY": "dg-test-deepgram",
    "ELEVENLABS_API_KEY": "el-test-elevenlabs",
    "MEETSTREAM_BASE_URL": "https://api.meetstream.ai/api/v1",
    "MEETING_LINK": "https://meet.google.com/abc-defg-hij",
    "BOT_NAME": "Meeting Assistant",
    "AGENT_NAME": "Meeting Assistant",
    "OPENAI_MODEL": "gpt-4.1",
    "LLM_TEMPERATURE": "0.7",
    "DEEPGRAM_MODEL": "nova-3",
    "TRANSCRIBE_LANGUAGE": "en",
    "TRANSCRIBE_BOOSTWORDS": "MeetStream, MIA ,Deepgram",
    "ELEVENLABS_VOICE_ID": "21m00Tcm4TlvDq8ikWAM",
    "ELEVENLABS_VOICE_SPEED": "1.0",
    "WAKE_WORD_ENABLED": "true",
    "WAKE_WORDS": "hey assistant,ok assistant",
    "WAKE_WORD_TIMEOUT": "30",
}

PROVIDER_SECRETS = (
    BASE_ENV["OPENAI_API_KEY"],
    BASE_ENV["DEEPGRAM_API_KEY"],
    BASE_ENV["ELEVENLABS_API_KEY"],
)


@pytest.fixture
def env():
    return dict(BASE_ENV)


@pytest.fixture
def settings(env):
    return Settings.from_env(env)


class FakeResponse:
    def __init__(self, status_code=200, body=None, text=None):
        self.status_code = status_code
        self._body = body
        self.text = text if text is not None else ("" if body is None else jsonlib.dumps(body))

    def json(self):
        return self._body


class FakeSession:
    """Stands in for requests.Session and records every call."""

    def __init__(self, responses=None):
        self.responses = list(responses or [])
        self.calls = []

    def request(self, method, url, headers=None, json=None, timeout=None):
        self.calls.append(
            {
                "method": method,
                "url": url,
                "headers": headers or {},
                "json": json,
                "timeout": timeout,
            }
        )
        if not self.responses:
            raise AssertionError("unexpected request: {} {}".format(method, url))
        return self.responses.pop(0)


class ExplodingSession:
    """Fails the test if anything tries to make a request."""

    def request(self, *args, **kwargs):
        raise AssertionError("the network was used when it should not have been")
