import io

import pytest

from live_captions.captions import CaptionPrinter
from live_captions.config import load_settings

ENV = {
    "MEETSTREAM_API_KEY": "ms_test_key",
    "PUBLIC_BASE_URL": "https://tunnel.example.com",
    "BOT_NAME": "Live Captions",
    "CAPTIONS_PORT": "8080",
    "RETENTION_HOURS": "24",
}


@pytest.fixture
def settings():
    return load_settings(env=dict(ENV))


@pytest.fixture
def output():
    return io.StringIO()


@pytest.fixture
def printer(output):
    # Plain text, no interim rewrites: makes assertions about what a user sees exact.
    return CaptionPrinter(stream=output, color=False, show_interim=False)
