# Product and OpenClaw setup

Verified against the live documentation on 2026-09-11. Read this for account,
platform, and installation setup; use [DOCS-INDEX.md](DOCS-INDEX.md) to find
all 119 published guide/API pages. Detailed API fields are in
[API-REFERENCE.md](API-REFERENCE.md) and [openapi.json](openapi.json).

## What runs where

MeetStream hosts meeting participants for Google Meet, Zoom, and Microsoft
Teams. They record mixed or per-person media, transcribe, report participants,
chat and speaker timelines, and support live media and interactive agents.
OpenClaw interprets the user's request locally and invokes this package's Bash
scripts; it is not the hosted bot or MIA runtime. A basic recording bot needs
no MIA configuration. A custom media bridge is a separately hosted service.
Sources: [overview](https://docs.meetstream.ai/welcome),
[bot lifecycle](https://docs.meetstream.ai/guides/introduction/how-bots-work).

## Install and authenticate

1. Install OpenClaw from its official installer and run
   `openclaw onboard --install-daemon`; configure the chosen model provider.
2. Run `openclaw gateway status` and `openclaw dashboard`.
3. Sign up at https://app.meetstream.ai/signup. Select the intended workspace,
   create a key at https://app.meetstream.ai/api-key, and configure needed
   provider integrations. Workspace keys, bots, webhooks, and usage are scoped.
4. In this package run `bash install.sh`. macOS uses `setup-macos.command`;
   Windows uses Ubuntu/WSL2 and `setup-windows.cmd`. Linux can run Bash directly.
   Bash, curl, jq, and Python 3 are needed; Python runs installer checks.
   The installer can install curl/jq using Homebrew or apt; install Python
   separately if unavailable. `--workspace PATH` selects the agent workspace.
5. Enter the key at the hidden prompt. The installer preserves existing `.env`
   credentials, installs the core and four companion skills, runs mock tests,
   restarts the gateway unless `--no-restart`, and runs `scripts/doctor.sh`.
6. Check `openclaw skills list` and start a fresh chat. The scripts load `.env`
   next to the core SKILL.md; an exported key takes precedence. Never commit it.

The REST base is `https://api.meetstream.ai/api/v1`, with
`Authorization: Token <key>` (not Bearer). The docs do not define selectable
regional API hosts. Rotate keys by deploying a replacement before revocation.
Sources: [dashboard](https://docs.meetstream.ai/guides/get-started/dashboard-setup),
[workspaces](https://docs.meetstream.ai/guides/get-started/workspaces),
[authentication](https://docs.meetstream.ai/api-reference/authentication).

OpenClaw's workspace skill takes precedence over managed/bundled copies.
Discovery stops descending once it finds a SKILL.md; companions therefore
need the sibling installation done by install.sh. If skill allowlists are
configured, include the required skill names. Host env injection does not
populate a sandbox: provision binaries and secrets in the actual execution
environment. A root-only registry/local install needs install.sh afterward
for this package's companions and credential setup.
Sources: [OpenClaw skills](https://docs.openclaw.ai/tools/skills),
[getting started](https://docs.openclaw.ai/start/getting-started).

## First bot to finished artifacts

Use a real user-supplied meeting link. In OpenClaw ask to join as a named
notetaker, select audio/video and provider, and state retention. Equivalent:

```bash
scripts/send-bot.sh --link '<actual-meeting-url>' --name 'Meeting Notetaker' --no-video --transcription deepgram --retention-hours 24
scripts/bot-status.sh '<returned-bot-id>'
scripts/remove-bot.sh '<returned-bot-id>'
scripts/get-transcript.sh '<returned-bot-id>'
scripts/bot-data.sh audio '<returned-bot-id>'
```

Save the bot ID; verify admission and recording rather than treating creation
as proof of a successful join. Fetch artifacts after their processing events.
HTTP 202 means pending; retry reads after 10–30 seconds with a bounded deadline.
Dashboard API Playground lets you configure a bot, preview it, and export the
request; use advanced JSON through `scripts/api-request.sh` when needed.
Sources: [first bot](https://docs.meetstream.ai/guides/get-started/create-your-first-bot),
[playground](https://docs.meetstream.ai/guides/get-started/api-playground).

## Platform setup

### Zoom

Create a General App in Zoom Marketplace; enable Features → Embed → Meeting
SDK. Store the matching client ID/secret in MeetStream Integrations → Zoom.
Development credentials are limited to meetings hosted by your Zoom account.
External use requires applicable app review plus join authorization. Keep the
complete invitation URL including its password query. The host must grant
recording permission; admission and recording are separate steps. Zoom has
fully isolated participant audio, but no native-caption or screenshot support.
Source: [Zoom platform](https://docs.meetstream.ai/guides/platforms/zoom).

For authenticated joins, your server owns OAuth, validates state, stores and
rotates refresh tokens, and hosts an authenticated HTTPS token-mint URL.
Typical scopes: `user:read:zak`, or `user:read:token` for OBF; add
`user:read:user` if needed for identity. Store SDK app credentials separately.
Source: [Marketplace setup](https://docs.meetstream.ai/guides/app-integrations/zoom-marketplace-app-setup).

Set exactly one `zoom.zak_url` (signed-in) or `zoom.obf_url` (on behalf of a
parent already in the call); omit `zoom` for guest joins. MeetStream adds
`meeting_number` for OBF; do not include it yourself. OBF tokens are minted
at join time and the bot leaves when its parent leaves. The token endpoint
returns plain text or JSON with `token`, `zak`, or `obf`; GET is attempted
first, with POST fallback on 405 or an unparseable token, not GET 400.
Token fetch failure does not fall back to guest. Deprecated
`use_zoom_obf` / `zoom_oauth_connection_user_id` are rejected.
Source: [authenticated Zoom](https://docs.meetstream.ai/guides/app-integrations/zoom-authenticated-bots).

For production, complete the Marketplace checklist with your listing,
privacy/terms/support, scope justifications, OAuth/token architecture, and
reviewer demonstrations. After approval, switch both the MeetStream integration
and your OAuth server to matching production credentials; retest admission,
recording, and OBF parent departure.
Source: [production submission](https://docs.meetstream.ai/guides/app-integrations/zoom-app-production-submission).

### Google Meet and Teams

Guest joins need no platform integration. Host lobby policy still applies;
Google signed-in identity is useful where anonymous users are blocked and
must not be presented as a universal admission bypass. Teams also supports
native captions and Outlook scheduling. Validate feature availability before
using a cross-platform recipe.
Sources: [Meet](https://docs.meetstream.ai/guides/platforms/google-meet),
[Teams](https://docs.meetstream.ai/guides/platforms/microsoft-teams),
[lobby troubleshooting](https://docs.meetstream.ai/guides/app-integrations/gmeet-lobby-admission).

For Google signed-in bots, use a Google Workspace domain and admin access.
Configure Security → Authentication → third-party IdP → Legacy SSO; enable
domain-specific issuer and set sign-in/sign-out URLs to
`https://api.meetstream.ai/api/v1/bot/gmeet-sign-in` and
`https://api.meetstream.ai/api/v1/bot/gmeet-sign-out`. Generate the certificate
and private key with OpenSSL, add the domain in MeetStream Integrations →
Google Signed-In Bots, and upload the pair for each login email. Keep private
keys out of chat. Create with `google_meet.login_required=true` and
`google_login_domain`; `sign_in_email` and `strict_email` select an identity.
The guide suggests one login per 20 peak concurrent meetings, rounded up.
Domain/login CRUD operations are in the API reference.
Source: [signed-in setup](https://docs.meetstream.ai/guides/app-integrations/google-signed-in-bots).

## Other official integration paths

The documentation-search MCP at `https://docs.meetstream.ai/_mcp/server` searches
docs; it does not operate bots. The action MCP, CLI, and Claude plugin are
separate optional interfaces. This package uses Bash and does not need them.
Read the indexed Build with AI pages before configuring one; do not confuse
MIA tool servers with the API action MCP or OpenClaw's own tools.
The index also includes agent skills and Recall.ai migration guidance. During
migration validate endpoint, payload and webhook changes instead of assuming
Recall's unsupported automatic-leave modes work here.
Sources: [AI docs](https://docs.meetstream.ai/build-with-ai/docs-for-agents),
[MCP](https://docs.meetstream.ai/build-with-ai/meetstream-mcp-server),
[CLI](https://docs.meetstream.ai/build-with-ai/meetstream-cli),
[migration](https://docs.meetstream.ai/migration/migrate-from-recall).

For unresolved issues collect bot ID, workspace, timestamps, HTTP status,
and sanitized payloads. Use dashboard bot details/logs and contact
support@meetstream.ai; never attach raw API keys or private meeting content
without the user's scope to share it.
Source: [support](https://docs.meetstream.ai/guides/help/support).
