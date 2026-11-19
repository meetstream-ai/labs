"""Create the MIA agent config and send a bot to a meeting with it."""

import argparse
import json
import logging
import os
import sys
from typing import Any, Dict, Mapping, Optional, Sequence

from .client import MeetStreamClient, MeetStreamError
from .config import ConfigError, Settings
from .payloads import build_agent_config, build_bot_request

logger = logging.getLogger("voice_agent")


def load_env(env_file: str = ".env") -> Dict[str, str]:
    """Merge the .env file with the real environment; exported vars win."""
    values: Dict[str, str] = {}
    if os.path.exists(env_file):
        from dotenv import dotenv_values

        values.update({k: v for k, v in dotenv_values(env_file).items() if v is not None})
    values.update({k: v for k, v in os.environ.items() if v})
    return values


def run(
    settings: Settings,
    meeting_link: str,
    dry_run: bool = False,
    session: Optional[Any] = None,
) -> Dict[str, Any]:
    """Create the agent config, then send a bot carrying it into the meeting.

    With dry_run the payloads are built and returned but nothing is sent.
    """
    agent_payload = build_agent_config(settings)

    if dry_run:
        print("POST {}/mia".format(settings.base_url))
        print(json.dumps(agent_payload, indent=2))
        print("\nPOST {}/bots/create_bot".format(settings.base_url))
        print(
            json.dumps(
                build_bot_request(meeting_link, settings.bot_name, "<agent_config_id>"),
                indent=2,
            )
        )
        print("\nDry run - nothing was sent to the MeetStream API.")
        return {"dry_run": True, "agent_config": agent_payload}

    client = MeetStreamClient(settings.meetstream_api_key, settings.base_url, session)

    agent_config_id = client.create_agent_config(agent_payload)
    print("Agent config created: {}".format(agent_config_id))

    bot = client.create_bot(
        build_bot_request(meeting_link, settings.bot_name, agent_config_id)
    )
    bot_id = bot.get("bot_id")
    print("Bot sent to {} (bot_id {}, status {})".format(meeting_link, bot_id, bot.get("status")))
    print("Remove it with: python -m voice_agent --remove {}".format(bot_id))

    return {"agent_config_id": agent_config_id, "bot": bot}


def main(argv: Optional[Sequence[str]] = None, env: Optional[Mapping[str, str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m voice_agent",
        description="Send a MeetStream voice agent (Deepgram + OpenAI + ElevenLabs) into a meeting.",
    )
    parser.add_argument("--meeting-link", help="Overrides MEETING_LINK from .env")
    parser.add_argument("--env-file", default=".env", help="Path to the .env file")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the payloads without calling the MeetStream API",
    )
    parser.add_argument("--status", metavar="BOT_ID", help="Print a bot's status and exit")
    parser.add_argument("--remove", metavar="BOT_ID", help="Remove a bot from its meeting")
    parser.add_argument("--verbose", action="store_true", help="Log each API call")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING)

    try:
        settings = Settings.from_env(env if env is not None else load_env(args.env_file))
    except ConfigError as exc:
        print("Configuration error: {}".format(exc), file=sys.stderr)
        return 2

    try:
        if args.status or args.remove:
            client = MeetStreamClient(settings.meetstream_api_key, settings.base_url)
            bot_id = args.status or args.remove
            result = client.get_bot_status(bot_id) if args.status else client.remove_bot(bot_id)
            print(json.dumps(result, indent=2))
            return 0

        meeting_link = args.meeting_link or settings.meeting_link
        if not meeting_link:
            print(
                "No meeting link - pass --meeting-link or set MEETING_LINK in .env",
                file=sys.stderr,
            )
            return 2

        run(settings, meeting_link, dry_run=args.dry_run)
    except MeetStreamError as exc:
        print("MeetStream API error: {}".format(exc), file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
