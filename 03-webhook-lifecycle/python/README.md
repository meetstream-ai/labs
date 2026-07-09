# meetstream-webhook-lifecycle / Python

This sample app shows how to receive MeetStream bot lifecycle events in real
time using webhooks. When you create a MeetStream bot with a callback_url,
MeetStream sends an HTTP POST request to that URL at every stage of the
bot's life in the meeting. This repo provides a local Flask server that
receives, logs, and saves each event as it arrives.

## What is a webhook

A webhook is an HTTP POST request that a service sends to your server when
something happens. Instead of your code asking "did anything happen yet?" on
a loop, the service tells you the moment something happens.

Without webhooks (polling):
```python
# Your code keeps asking MeetStream "is the bot done yet?"
while True:
    status = get_bot_status(bot_id)
    if status == "Done":
        break
    time.sleep(10)
```

With webhooks (event-driven):
```python
# MeetStream calls YOUR server the moment the bot's status changes
@app.route("/webhooks/meetstream", methods=["POST"])
def webhook():
    event = request.json
    if event["event"] == "bot.stopped":
        handle_meeting_ended(event["bot_id"])
    return "", 200
```

Webhooks are more efficient and give you faster reactions to events because
there is no polling delay.

## Lifecycle event reference

| Event                            | When it fires                                     | Bot status at time of event |
|----------------------------------|---------------------------------------------------|-----------------------------|
| bot.joining                      | Bot dispatched, attempting to join waiting room   | Joining                     |
| bot.inmeeting                    | Bot admitted and recording started                | Active                      |
| bot.recording                    | Recording confirmed active                        | Active                      |
| bot.leaving                      | Bot is leaving the meeting                        | Stopping                    |
| bot.stopped                      | Bot has left, post-processing started             | Done                        |
| bot.done                         | Post-processing complete, media files ready       | Done                        |
| bot.notallowed                   | Host did not admit bot before timeout             | NotAllowed                  |
| bot.failed                       | Bot encountered a fatal error                     | Fatal                       |
| bot.recording_permission_denied  | Zoom host denied recording permission             | PermissionDenied            |

Example payload for bot.inmeeting:

```json
{
  "event": "bot.inmeeting",
  "bot_id": "f8025eaa-6b0d-48b9-b2a5-d085befa9b83",
  "status": "Active",
  "timestamp": "2026-07-06T11:32:04Z",
  "meeting_url": "https://meet.google.com/abc-defg-hij",
  "message": "Bot is now in the meeting and recording"
}
```

## Prerequisites

- Python 3.9 or higher
- A MeetStream account and API key (sign up at app.meetstream.ai)
- ngrok installed and authenticated (download at ngrok.com/download)
- A Google Meet, Zoom, or Microsoft Teams meeting link

## Setup

1. Navigate to the python directory

   From the root of the meetstream-sample-apps repository:
   ```
   cd sample-apps/03-webhook-lifecycle/python
   ```

2. Install dependencies
   ```
   pip install -r requirements.txt
   ```

3. Start the webhook server

   Open a terminal window and run:
   ```
   python webhook_server.py
   ```
   Expected output:
   ```
   MeetStream Webhook Server running on http://0.0.0.0:3000
   Webhook endpoint: http://0.0.0.0:3000/webhooks/meetstream
   Events will be saved to: /your/path/events
   Waiting for events...
   ```

4. Start the ngrok tunnel

   Open a second terminal window and run:
   ```
   ngrok http 3000 --host-header="localhost:3000"
   ```
   Copy the Forwarding URL from the ngrok output:
   ```
   Forwarding    https://abc123.ngrok-free.app -> http://localhost:3000
   ```
   Your webhook callback URL is:
   ```
   https://abc123.ngrok-free.app/webhooks/meetstream
   ```
   Note: append /webhooks/meetstream to the ngrok URL. Do not use the bare domain.

5. Configure environment variables
   ```
   cp .env.example .env
   ```
   Open .env and set:
   - MEETSTREAM_API_KEY to your MeetStream API key
   - CALLBACK_URL to https://abc123.ngrok-free.app/webhooks/meetstream

6. Create the bot

   Open a third terminal window and run:
   ```
   python create_bot.py "https://meet.google.com/abc-defg-hij"
   ```
   Expected output:
   ```
   Bot created: f8025eaa-6b0d-48b9-b2a5-d085befa9b83
   Callback URL: https://abc123.ngrok-free.app/webhooks/meetstream
   Status: Active

   Bot is now dispatched. Admit it in your meeting to see lifecycle events.
   Watch the webhook_server.py terminal for incoming events.
   ```

7. Admit the bot and watch events arrive

   Open the meeting link in your browser.
   Admit the bot when it appears in the waiting room.
   Switch to the webhook_server.py terminal and watch events print as they fire.

## Expected output

Complete expected output in the webhook_server.py terminal across a full
meeting session from join to completion:

```
[2026-07-06 11:31:58] EVENT RECEIVED
Event:       bot.joining
Bot ID:      f8025eaa-6b0d-48b9-b2a5-d085befa9b83
Status:      Joining
Message:     Bot is joining the meeting
Description: Bot has been dispatched and is attempting to join the meeting waiting room
Raw payload: {"event": "bot.joining", "bot_id": "f8025eaa-...", "status": "Joining"}
----------------------------------------

[2026-07-06 11:32:04] EVENT RECEIVED
Event:       bot.inmeeting
Bot ID:      f8025eaa-6b0d-48b9-b2a5-d085befa9b83
Status:      Active
Meeting URL: https://meet.google.com/abc-defg-hij
Message:     Bot is now in the meeting and recording
Description: Bot has been admitted and is now actively recording
Raw payload: {"event": "bot.inmeeting", ...}
----------------------------------------

[2026-07-06 11:40:38] EVENT RECEIVED
Event:       bot.leaving
Bot ID:      f8025eaa-6b0d-48b9-b2a5-d085befa9b83
Status:      Stopping
Message:     Bot is leaving the meeting
Description: Bot is in the process of leaving the meeting
Raw payload: {"event": "bot.leaving", ...}
----------------------------------------

[2026-07-06 11:40:41] EVENT RECEIVED
Event:       bot.stopped
Bot ID:      f8025eaa-6b0d-48b9-b2a5-d085befa9b83
Status:      Done
Message:     Bot has left and post-processing has started
Description: Bot has left the meeting and post-processing has started
Raw payload: {"event": "bot.stopped", ...}
----------------------------------------
```

Events are also saved to the events/ folder:
```
events/
  bot_joining_f8025eaa_1743500118.json
  bot_inmeeting_f8025eaa_1743500124.json
  bot_leaving_f8025eaa_1743500638.json
  bot_stopped_f8025eaa_1743500641.json
```

## Usage - Headless mode

Headless mode applies to create_bot.py only.
The webhook server always runs as a normal interactive process.

```
python create_bot.py "https://meet.google.com/abc-defg-hij" --headless
```

Expected output:
```
[headless] Creating bot...
[headless] Bot created: f8025eaa-6b0d-48b9-b2a5-d085befa9b83
[headless] Callback URL: https://abc123.ngrok-free.app/webhooks/meetstream
[headless] Status: Active
[headless] Bot dispatched. Webhook events will arrive at the callback URL.
[headless] Exiting with code 0
```

In a CI pipeline, the webhook server would typically be running as a
separate long-running service. create_bot.py dispatches the bot and exits.
Events arrive asynchronously at the webhook server.

## Usage - Web dashboard

As an alternative to the CLI, webhook_server.py serves a local dashboard
at:
```
http://localhost:3000
```
(or whatever port WEBHOOK_PORT is set to).

The dashboard lets you paste in your MeetStream API key and a meeting
link, click "Deploy Agent", and watch lifecycle events arrive in a live
log panel plus a current-session table, without using create_bot.py at
all. CALLBACK_URL must still be set in .env to your ngrok URL first,
exactly as in the CLI setup above, since MeetStream needs a public URL
to call back to.

1. Complete Setup steps 1 through 5 above (install dependencies, start
   the webhook server, start ngrok, set CALLBACK_URL in .env).
2. Open `http://localhost:3000` in your browser.
3. Paste your MeetStream API key and the meeting link into the Deploy
   Agent card, then click "Deploy Agent".
4. Admit the bot in your meeting when it appears in the waiting room.
5. Watch the Live Logs card and Current Session table update as events
   arrive, and the Output Files card fill in as event JSON files are saved.

The dashboard and the CLI both talk to the same webhook_server.py process
and the same events/ directory, so you can mix and match: deploy a bot
from the dashboard while still watching the terminal, or deploy from
create_bot.py and watch the dashboard update instead.

## Using the saved event files

Each event is saved as a JSON file in events/ for debugging and inspection.

View a specific event:
```
cat events/bot_inmeeting_f8025eaa_1743500124.json
```

List all events for a specific bot:
```
ls events/ | grep f8025eaa
```

Count total events received in a session:
```
ls events/ | wc -l
```

In production, instead of saving to files, you would process events in the
webhook handler and write them to a database, publish them to a message queue,
or trigger downstream logic.

Example of processing bot.stopped to trigger a transcript fetch:
```python
@app.route("/webhooks/meetstream", methods=["POST"])
def meetstream_webhook():
    data = request.get_json()
    event_type = data.get("event")
    bot_id = data.get("bot_id")

    if event_type == "bot.stopped":
        # Meeting ended, trigger transcript fetch in background
        transcript_id = get_transcript_id_for_bot(bot_id)
        schedule_transcript_fetch(transcript_id)

    return jsonify({"status": "received"}), 200
```

## Why your server must return 2xx quickly

MeetStream expects a 2xx HTTP response from your webhook endpoint within
a few seconds. If your endpoint takes too long or returns a non-2xx status,
MeetStream will retry the webhook delivery.

This means your webhook handler should:
- Return the 200 response immediately after parsing the event
- Do any heavy processing (database writes, API calls) asynchronously after returning

Example of what NOT to do:
```python
@app.route("/webhooks/meetstream", methods=["POST"])
def webhook():
    data = request.get_json()
    # Do not do this - slow processing before returning
    time.sleep(10)
    fetch_transcript_from_api(data["bot_id"])
    return jsonify({"status": "ok"}), 200
```

Example of the correct pattern:
```python
from threading import Thread

@app.route("/webhooks/meetstream", methods=["POST"])
def webhook():
    data = request.get_json()
    # Return immediately
    Thread(target=process_event_async, args=(data,)).start()
    return jsonify({"status": "received"}), 200

def process_event_async(data):
    # Do slow work here, after the response has been sent
    if data["event"] == "bot.stopped":
        fetch_transcript_from_api(data["bot_id"])
```

## Troubleshooting

Issue 1: No events appear in the webhook server terminal after admitting the bot

Three things to check in order:

Check 1: Confirm CALLBACK_URL in .env ends with /webhooks/meetstream and not
just the bare ngrok domain.
```
# Wrong
CALLBACK_URL=https://abc123.ngrok-free.app

# Correct
CALLBACK_URL=https://abc123.ngrok-free.app/webhooks/meetstream
```

Check 2: Open the ngrok dashboard at http://127.0.0.1:4040 and look at the
Connections count. If it shows 0, MeetStream has not attempted to connect
to your URL at all. This means the CALLBACK_URL in the bot payload was wrong
when the bot was created. Create a new bot with the correct URL.

Check 3: Confirm the ngrok tunnel is pointing to port 3000 and the webhook
server is running on port 3000.

Issue 2: Events arrive in ngrok but nothing appears in webhook_server.py terminal

Symptom: The ngrok dashboard at http://127.0.0.1:4040 shows incoming POST
requests but the Flask terminal shows nothing.

Cause: The ngrok tunnel is forwarding to the wrong port, or Flask is running
on a different port than ngrok is tunneling to.

Fix: Confirm WEBHOOK_PORT in .env matches the port in the ngrok command.
Default is 3000 for both.

Issue 3: "502 Bad Gateway" appears in ngrok dashboard

Cause: ngrok is running but the Flask webhook server is not running,
or crashed after startup.

Fix: Check the webhook_server.py terminal for error messages.
Restart it with:
```
python webhook_server.py
```

Issue 4: Placeholder CALLBACK_URL error

Symptom:
```
Error: CALLBACK_URL in .env still has the placeholder value.
Run ngrok and update CALLBACK_URL with your actual ngrok URL.
```

Fix: Start ngrok, copy the Forwarding URL, append /webhooks/meetstream,
and update CALLBACK_URL in your .env file before running create_bot.py.

Issue 5: bot.notallowed event fires instead of bot.inmeeting

Cause: The bot was not admitted into the meeting before the
waiting_room_timeout expired. The default timeout is 600 seconds (10 minutes).

Fix: After running create_bot.py, open your meeting link in the browser
and admit the bot within 10 minutes. The bot will appear in the waiting room
with the name "MeetStream Webhook Bot".

## Related MeetStream documentation

- Webhooks and Events: https://docs.meetstream.ai/guides/webhooks/webhooks-and-events
- Set Up Local Server for Webhook: https://docs.meetstream.ai/guides/webhooks/set-up-local-server-for-webhook
- Automatic Leave Configurations: https://docs.meetstream.ai/guides/features/automatic-leave-configurations
- Create Bot API reference: https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot

## License

This repository is MIT licensed.
