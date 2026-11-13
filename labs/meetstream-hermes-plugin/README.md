# MeetStream plugin for Hermes

This package contains the Hermes-native `meetstream` skill and the small
MeetStream bridge it uses for authenticated meeting-session management.

The skill gives Hermes deterministic commands for:

- joining a Google Meet, Zoom, or Microsoft Teams meeting;
- listing and inspecting active sessions;
- listing the account's MIA configurations; and
- removing a specific session's bot.

The bridge keeps MeetStream and Hermes credentials server-side. The skill
communicates with the bridge using only `MEETSTREAM_BRIDGE_URL` and the
separate `MEETSTREAM_BRIDGE_KEY`.

## Install

```sh
./install.sh
cd ~/.hermes/skills/meetstream/bridge
npm install
npm run setup
npm run doctor
npm run plugin
```

The installer refuses to overwrite an existing installation. See
`SKILL.md` and `bridge/QUICKSTART.md` for configuration and safety details.

## Verify

```sh
python3 -m unittest discover -s test -v
cd bridge
npm run check
```

The tests use local fakes and do not join a real meeting. Live validation
requires a MeetStream API key, an authenticated Hermes gateway, public HTTPS
and WSS ingress, and a meeting where a host can admit the bot.
