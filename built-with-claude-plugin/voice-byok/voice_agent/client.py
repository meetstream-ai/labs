"""Thin MeetStream REST client covering the MIA + bot calls this app needs."""

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

TIMEOUT_SECONDS = 30


class MeetStreamError(RuntimeError):
    """A MeetStream API call returned a non-2xx response."""

    def __init__(self, method: str, path: str, status_code: int, body: str):
        self.status_code = status_code
        self.body = body
        hint = ""
        if status_code == 401:
            hint = " - check MEETSTREAM_API_KEY (header is 'Authorization: Token <key>')"
        super().__init__(
            "{} {} failed with HTTP {}{}: {}".format(method, path, status_code, hint, body)
        )


class MeetStreamClient:
    """Calls the MeetStream API.

    `session` is injected so tests (and dry runs) never touch the network.
    """

    def __init__(self, api_key: str, base_url: str, session: Optional[Any] = None):
        if session is None:
            import requests

            session = requests.Session()
        self._session = session
        self._base_url = base_url.rstrip("/")
        self._headers = {
            "Authorization": "Token {}".format(api_key),
            "Content-Type": "application/json",
        }

    def create_agent_config(self, payload: Dict[str, Any]) -> str:
        """Create a MIA agent config and return its agent_config_id."""
        body = self._request("POST", "/mia", json=payload)
        agent_config_id = body.get("agent_config_id")
        if not agent_config_id:
            raise MeetStreamError("POST", "/mia", 200, "response had no agent_config_id")
        return agent_config_id

    def create_bot(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Send a bot to a meeting. Returns the BotResponse (bot_id, status, ...)."""
        return self._request("POST", "/bots/create_bot", json=payload)

    def get_bot_status(self, bot_id: str) -> Dict[str, Any]:
        return self._request("GET", "/bots/{}/status".format(bot_id))

    def remove_bot(self, bot_id: str) -> Dict[str, Any]:
        """Pull the bot out of the meeting. GET, per the API spec."""
        return self._request("GET", "/bots/{}/remove_bot".format(bot_id))

    def _request(
        self, method: str, path: str, json: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        url = self._base_url + path
        logger.info("%s %s", method, path)
        logger.debug("request body: %s", json)
        response = self._session.request(
            method, url, headers=self._headers, json=json, timeout=TIMEOUT_SECONDS
        )
        if not 200 <= response.status_code < 300:
            raise MeetStreamError(method, path, response.status_code, response.text)
        if not response.text:
            return {}
        return response.json()
