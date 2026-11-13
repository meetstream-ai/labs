import importlib.util
import io
import os
import unittest
from pathlib import Path
from contextlib import redirect_stdout
from unittest.mock import Mock, patch


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "meetstream.py"
spec = importlib.util.spec_from_file_location("meetstream", MODULE_PATH)
meetstream = importlib.util.module_from_spec(spec)
spec.loader.exec_module(meetstream)


class MeetStreamSkillTests(unittest.TestCase):
    def test_accepts_supported_meeting_urls(self):
        for url in (
            "https://meet.google.com/abc-defg-hij",
            "https://us02web.zoom.us/j/123",
            "https://teams.microsoft.com/l/meetup-join/abc",
        ):
            self.assertEqual(meetstream.meeting_url(url), url)

    def test_rejects_non_https_or_unknown_host(self):
        with self.assertRaises(SystemExit):
            meetstream.meeting_url("http://meet.google.com/abc")
        with self.assertRaises(SystemExit):
            meetstream.meeting_url("https://example.com/meeting")

    def test_join_uses_server_side_configuration(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(meetstream, "request", return_value={"state": "joining"}) as mocked:
            result = meetstream.join("https://meet.google.com/abc-defg-hij")
        self.assertEqual(result, {"state": "joining"})
        self.assertEqual(mocked.call_args.args[:2], ("POST", "/v1/meeting-sessions/from-env"))
        payload = mocked.call_args.args[2]
        self.assertEqual(payload, {"meeting_url": "https://meet.google.com/abc-defg-hij"})

    def test_mia_list_maps_to_bridge_route(self):
        output = io.StringIO()
        with patch.object(meetstream, "request", return_value={"agent_configs": [], "count": 0}) as mocked, redirect_stdout(output):
            self.assertEqual(meetstream.main(["meetstream.py", "mia-list"]), 0)
        mocked.assert_called_once_with("GET", "/v1/mia-configurations")
        self.assertIn('"count": 0', output.getvalue())

    def test_request_sends_only_bridge_management_key(self):
        response = Mock()
        response.read.return_value = b'{"status":"ok"}'
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        with patch.dict(os.environ, {
            "MEETSTREAM_BRIDGE_URL": "https://bridge.test",
            "MEETSTREAM_BRIDGE_KEY": "manage-secret",
            "MEETSTREAM_API_KEY": "must-not-be-sent",
            "HERMES_API_KEY": "must-not-be-sent",
        }, clear=True), patch.object(meetstream, "urlopen", return_value=response) as opened:
            self.assertEqual(meetstream.request("GET", "/v1/mia-configurations"), {"status": "ok"})
        sent = opened.call_args.args[0]
        self.assertEqual(sent.headers["X-integration-key"], "manage-secret")
        self.assertNotIn("must-not-be-sent", repr(sent.headers))

    def test_redacts_secret_fields_recursively(self):
        self.assertEqual(meetstream.redact({"api_key": "secret", "nested": {"token": "x", "state": "in_meeting"}}), {"api_key": "[redacted]", "nested": {"token": "[redacted]", "state": "in_meeting"}})


if __name__ == "__main__":
    unittest.main()
