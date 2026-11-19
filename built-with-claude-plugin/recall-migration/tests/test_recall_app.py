import recall_app


class FakeResp:
    def __init__(self, data):
        self._d = data

    def json(self):
        return self._d

    def raise_for_status(self):
        pass


class FakeSession:
    def __init__(self):
        self.calls = []

    def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append(("POST", url, json))
        return FakeResp({"id": "bot_123"})

    def get(self, url, headers=None, timeout=None):
        self.calls.append(("GET", url, None))
        if url.endswith("/bot/bot_123/"):
            return FakeResp({"recordings": [{"media_shortcuts": {"transcript": {"data": {"download_url": "https://x/t.json"}}}}]})
        return FakeResp([{"participant": {"name": "Ana"}, "words": [{"text": "hello"}, {"text": "all"}]}])


def test_send_bot(monkeypatch):
    monkeypatch.setenv("RECALL_API_KEY", "k")
    s = FakeSession()
    assert recall_app.send_bot("https://meet.google.com/abc-defg-hij", session=s) == "bot_123"
    assert s.calls[0][1].endswith("/api/v1/bot/")


def test_get_transcript(monkeypatch):
    monkeypatch.setenv("RECALL_API_KEY", "k")
    assert recall_app.get_transcript("bot_123", session=FakeSession()) == "Ana: hello all"
