# Security policy

## Supported versions

Security fixes are applied to the latest published release. Users should
update before reporting behavior that may already have been corrected.

## Reporting a vulnerability

Do not open a public issue containing credentials, meeting links, bot IDs, or
exploit details. Contact the maintainer through the private security-reporting
channel associated with the source repository or ClawHub publisher. Include:

- the affected version and operating system;
- the smallest safe reproduction;
- the security impact and required attacker access; and
- whether a MeetStream API key may have been exposed.

Revoke and replace any API key that may have entered shell history, logs, or
an untrusted file. Never attach a real `.env` to a report.

## Security invariants

- Production credentials are sent only to `https://api.meetstream.ai/api/v1`.
- `.env` is parsed as data and never executed as shell code.
- Credential files must be regular, non-symlink files with mode 0600.
- Bot creation and removal require explicit, unambiguous user intent.
- Live chat and calendar schedule changes require an explicit bot or event.
- Meeting URLs are restricted to supported HTTPS meeting providers.
- Callback, avatar, and live-transcript destinations must be public HTTPS URLs.
- Transcripts, participant data, chat, and presigned media URLs are treated as sensitive meeting data.
- Tests use only a loopback mock and a dummy API key.
