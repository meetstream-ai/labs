# meetstream-live-transcription / Python

This sample app demonstrates live transcription with MeetStream. As meeting
participants speak, transcribed sentences arrive at your server within 1 to
2 seconds. Each sentence includes the speaker label, text, timestamps, and
confidence score. The server displays sentences in real time and saves a
complete transcript file when the session ends.

## Live vs post-call transcription

| Aspect              | Live Transcription             | Post-Call Transcription         |
|---------------------|--------------------------------|---------------------------------|
| When you get it     | During the meeting, 1-2s delay | After meeting ends, 1-3min delay|
| Deepgram model      | nova-2 (streaming)             | nova-3 (batch)                  |
| Accuracy            | Good                           | Higher                          |
| Delivery method     | Webhook per sentence           | API fetch after meeting ends    |
| Best for            | Live captions, real-time alerts| Notes, summaries, archiving     |
| Provider key        | deepgram_streaming             | deepgram                        |

## How it works

1. You start a local Flask server that listens for incoming POST requests
   on the /live-transcript endpoint
2. You expose the server publicly using ngrok so MeetStream can reach it
3. You create a MeetStream bot with live_transcription_required.webhook_url
   pointing to your public ngrok URL
4. After the bot is admitted and starts recording, MeetStream streams audio
   to Deepgram Streaming in real time
5. As Deepgram detects complete sentences, MeetStream POSTs each one to
   your webhook URL within 1 to 2 seconds
6. Your server receives the payload, displays the sentence, and accumulates
   it in memory
7. Every 50 sentences a checkpoint file is saved to the transcripts/ folder
8. When the meeting ends you can save the final transcript manually

```
Meeting participant speaks
          |
          v
MeetStream bot captures audio
          |
          v
Deepgram Streaming processes audio in real time
          |
          v (1-2 seconds)
MeetStream POSTs sentence to your webhook URL
          |
          v
transcription_server.py receives POST at /live-transcript
          |
          v
Sentence printed to terminal + accumulated in memory
          |
          v (every 50 sentences or on manual save)
Checkpoint saved to transcripts/ folder
```

## Prerequisites

- Python 3.9 or higher
- A MeetStream account and API key (sign up at app.meetstream.ai)
- ngrok installed and authenticated (download at ngrok.com/download)
- A Google Meet, Zoom, or Microsoft Teams meeting link

## Setup

Step 1: Navigate to the python directory

From the root of the meetstream-sample-apps repository:
```
cd sample-apps/04-live-transcription/python
```

Step 2: Install dependencies
```
pip install -r requirements.txt
```

Step 3: Start the transcription server

Open a terminal window and run:
```
python transcription_server.py
```

Expected output:
```
MeetStream Live Transcription Server running on http://0.0.0.0:4000
Webhook endpoint: http://0.0.0.0:4000/live-transcript
Transcripts will be saved to: /your/path/transcripts
Waiting for sentences...
```

Step 4: Start the ngrok tunnel

Open a second terminal window and run:
```
ngrok http 4000 --host-header="localhost:4000"
```

Copy the Forwarding URL:
```
Forwarding    https://abc123.ngrok-free.app -> http://localhost:4000
```

Your webhook URL is:
```
https://abc123.ngrok-free.app/live-transcript
```

Note: append /live-transcript to the ngrok URL.

Step 5: Configure environment variables
```
cp .env.example .env
```

Open .env and set:
- MEETSTREAM_API_KEY to your MeetStream API key
- WEBHOOK_URL to https://abc123.ngrok-free.app/live-transcript

Step 6: Create the bot

Open a third terminal window and run:
```
python create_bot.py "https://meet.google.com/abc-defg-hij"
```

Expected output:
```
Creating bot with live transcription...
Bot created: f8025eaa-6b0d-48b9-b2a5-d085befa9b83
Webhook URL: https://abc123.ngrok-free.app/live-transcript
Status: Active

Bot is dispatched. Admit it in your meeting to start receiving live transcription.
Watch the transcription_server.py terminal for incoming sentences.

To save the transcript manually at any time, run:
  curl -X POST http://localhost:4000/save/f8025eaa-6b0d-48b9-b2a5-d085befa9b83
```

Step 7: Admit the bot and watch sentences arrive

Open the meeting link in your browser. Admit the bot when it appears in the
waiting room. Start speaking. Sentences will appear in the transcription
server terminal within 1 to 2 seconds.

## Expected output

Show the transcription server terminal output during a meeting:

```
MeetStream Live Transcription Server running on http://0.0.0.0:4000
Webhook endpoint: http://0.0.0.0:4000/live-transcript
Transcripts will be saved to: /your/path/transcripts
Waiting for sentences...

[00:03] Speaker 0 (confidence: 0.98)
Hello, can everyone hear me?

[00:06] Speaker 1 (confidence: 0.97)
Yes, loud and clear.

[00:09] Speaker 0 (confidence: 0.99)
Great. Let us look at the API integration timeline for this sprint.

[00:14] Speaker 1 (confidence: 0.95)
I think we need at least two more weeks for the authentication service.

[00:19] Speaker 0 (confidence: 0.96)
Agreed. Let us push the deadline to end of month.
```

## Saving the transcript

Auto-save: The server automatically saves a checkpoint every 50 sentences.
```
[checkpoint] Transcript saved: transcripts/transcript_f8025eaa_1743500200.json (50 sentences)
```

Manual save: Trigger a save at any time by calling the /save/{bot_id} endpoint:
```
curl -X POST http://localhost:4000/save/f8025eaa-6b0d-48b9-b2a5-d085befa9b83
```

Response:
```json
{
  "status": "saved",
  "filepath": "transcripts/transcript_f8025eaa_1743500200.json",
  "sentence_count": 23
}
```

Saved transcript format:
```json
{
  "bot_id": "f8025eaa-6b0d-48b9-b2a5-d085befa9b83",
  "sentence_count": 23,
  "saved_at": "2026-07-06T11:45:00Z",
  "sentences": [
    {
      "speaker": "Speaker 0",
      "speaker_id": "user_abc123",
      "text": "Hello, can everyone hear me?",
      "start": 3.2,
      "end": 5.1,
      "confidence": 0.98,
      "received_at": "2026-07-06T11:32:06Z"
    }
  ]
}
```

## Usage - Headless mode

Headless mode applies to create_bot.py only. The transcription server
always runs as a normal interactive process.

```
python create_bot.py "https://meet.google.com/abc-defg-hij" --headless
```

Expected output:
```
[headless] Creating bot with live transcription...
[headless] Bot created: f8025eaa-6b0d-48b9-b2a5-d085befa9b83
[headless] Webhook URL: https://abc123.ngrok-free.app/live-transcript
[headless] Status: Active
[headless] Bot dispatched. Live transcription payloads will arrive at the webhook URL.
[headless] Exiting with code 0
```

## Web dashboard (alternative to the CLI)

Besides running create_bot.py and transcription_server.py separately from
the command line, this sample also includes app.py: a single Flask process
that combines bot deployment and the live transcription webhook receiver
behind a browser dashboard. This is a second, UI-based way to do the same
thing; it uses the same MeetStream live transcription API and the same
webhook payload handling as the CLI path, which continues to work
unchanged.

Setup steps 1, 2, 4, and 5 from the Setup section above still apply
(install dependencies, start ngrok, configure .env). Skip steps 3 and 6
and instead run:

```
python app.py
```

Expected output:
```
MeetStream Live Transcription Dashboard running on http://0.0.0.0:4000
Open http://localhost:4000 in your browser to deploy a bot and watch sentences arrive.
Webhook endpoint: http://0.0.0.0:4000/live-transcript
Transcripts will be saved to: /your/path/transcripts
```

Open `http://localhost:4000` in your browser. The dashboard has four
sections:

- Deploy Agent: paste your MeetStream API key and meeting link, then click
  Deploy Agent. If MEETSTREAM_API_KEY is already set in .env, you can leave
  the field blank and it will be used automatically. Stat tiles show
  Status, Elapsed time, Sentences Received, and Transcripts Saved, updating
  every 1.5 seconds.
- Session: details for the most recently deployed bot (bot ID, platform,
  meeting link, start time, duration, status).
- Live Logs: the full log of deploy events, received sentences, and
  checkpoint saves, equivalent to the transcription_server.py terminal
  output.
- Output Files: the list of saved transcript checkpoint files, each with a
  download link.

The dashboard exposes the same /live-transcript and /save/{bot_id}
endpoints as transcription_server.py, on the same SERVER_PORT, so
WEBHOOK_URL in .env does not need to change between the CLI and dashboard
workflows.

## Deepgram Streaming configuration

| Parameter          | Value    | What it does                                              |
|--------------------|----------|-------------------------------------------------------------|
| model              | nova-2   | Deepgram's streaming model (lower latency than nova-3)    |
| transcription_mode | sentence | Delivers one complete sentence per webhook payload        |
| language           | en       | Language code for the audio                               |
| punctuate          | true     | Adds punctuation automatically                            |
| smart_format       | true     | Formats numbers, dates, times intelligently               |
| endpointing        | 300      | Milliseconds of silence before declaring sentence end     |
| vad_events         | true     | Fires events when speech starts and stops                 |
| utterance_end_ms   | 1000     | Milliseconds of silence after last word before delivery   |
| encoding           | linear16 | Audio encoding format                                     |
| channels           | 1        | Mono audio                                                |

Explain transcription_mode with a concrete example:

sentence mode (recommended): Each POST to your webhook contains one
complete sentence:
```json
{"text": "Let us look at the API integration timeline for this sprint.", "is_final": true}
```

word mode (high frequency): Each POST contains a single word, which means
many more requests per second:
```json
{"text": "Let", "is_final": false}
{"text": "Let us", "is_final": false}
{"text": "Let us look", "is_final": false}
```

Sentence mode is recommended because it reduces webhook traffic and
produces more useful chunks of text for downstream processing.

Explain endpointing with a concrete example:

endpointing controls how long Deepgram waits after hearing the last word
before it decides the speaker has finished their sentence.

endpointing: 300 (300ms pause triggers sentence end): Speaker says "We need
to..." then pauses for 400ms then continues. Result: two separate sentences
sent to your webhook.

endpointing: 1000 (1000ms pause triggers sentence end): Same pause of
400ms. Result: treated as one continuous sentence, 400ms pause is not long
enough.

Use a smaller endpointing value for faster delivery with more sentence
splits. Use a larger value to group naturally connected phrases into one
sentence.

## Interim vs final results

Explain the is_final field with a concrete example:

Deepgram sends results before the sentence is finished. These interim
results update as more audio comes in.

Example sequence for "Hello can everyone hear me":

Interim result 1 (is_final: false):
```json
{"text": "Hello", "is_final": false}
```

Interim result 2 (is_final: false):
```json
{"text": "Hello can everyone", "is_final": false}
```

Final result (is_final: true):
```json
{"text": "Hello, can everyone hear me?", "is_final": true, "confidence": 0.98}
```

This server skips interim results and only processes final results. This
means less processing overhead and cleaner output.

If you want to display partial sentences as they form (for a live caption
display), you can remove the is_final check in transcription_server.py:

```python
# Remove this block to process interim results:
if not is_final:
    return jsonify({"status": "skipped", "reason": "interim result"}), 200
```

Note that interim results will arrive much more frequently and the same
sentence will appear multiple times with progressively more words added.

## Troubleshooting

Issue 1: No sentences appear in the transcription server terminal

Three things to check in order:

Check 1: Confirm WEBHOOK_URL in .env ends with /live-transcript.
```
# Wrong
WEBHOOK_URL=https://abc123.ngrok-free.app

# Correct
WEBHOOK_URL=https://abc123.ngrok-free.app/live-transcript
```

Check 2: Confirm live_transcription_required is in the bot payload, not
callback_url. The live transcription webhook uses a different field name
from the lifecycle webhook.

Check 3: Speak clearly and for at least 5 seconds after the bot is
admitted. Deepgram Streaming needs a short buffer before the first
sentence is delivered.

Issue 2: Sentences appear but all show "Speaker 0" instead of real names

Cause: Deepgram Streaming assigns numeric labels (Speaker 0, Speaker 1)
based on voice characteristics, not based on the participant's display name
in the meeting platform.

This is expected behavior. The speaker_id field in the payload contains the
platform-specific identifier which can be cross-referenced with
participant metadata from the bot's participant endpoint if needed.

Issue 3: Sentences are cut off mid-thought

Cause: The endpointing value (default 300ms) is too short for the
speaker's natural speaking rhythm. A 300ms pause is being interpreted as
the end of a sentence.

Fix: Increase endpointing in DEEPGRAM_STREAMING_CONFIG in create_bot.py:
```python
DEEPGRAM_STREAMING_CONFIG = {
    ...
    "endpointing": 700,   # increase from 300 to 700ms
    ...
}
```

Issue 4: Transcript not saving at the expected checkpoint

Cause: If fewer than 50 sentences have arrived, no auto-save checkpoint has
been triggered yet.

Fix: Trigger a manual save using the /save endpoint:
```
curl -X POST http://localhost:4000/save/{bot_id}
```

Replace {bot_id} with the bot ID printed when the bot was created.

## Building on this example

Show three patterns a developer would add to make this production-ready:

Pattern 1: Forwarding sentences to a browser UI via WebSocket
```python
from flask_socketio import SocketIO
socketio = SocketIO(app)

@app.route("/live-transcript", methods=["POST"])
def live_transcript():
    data = request.get_json()
    if data.get("is_final"):
        socketio.emit("sentence", data)  # push to connected browser clients
    return jsonify({"status": "received"}), 200
```

Pattern 2: Detecting action items in real time
```python
ACTION_TRIGGERS = ["we need to", "can you", "please", "by friday", "follow up"]

@app.route("/live-transcript", methods=["POST"])
def live_transcript():
    data = request.get_json()
    if data.get("is_final"):
        text_lower = data["text"].lower()
        if any(trigger in text_lower for trigger in ACTION_TRIGGERS):
            print(f"[ACTION ITEM DETECTED] {data['speaker']}: {data['text']}")
    return jsonify({"status": "received"}), 200
```

Pattern 3: Writing sentences to a database
```python
import sqlite3

def save_to_db(sentence_data: dict) -> None:
    conn = sqlite3.connect("transcripts.db")
    conn.execute(
        "INSERT INTO sentences (bot_id, speaker, text, start, end, confidence) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (sentence_data["bot_id"], sentence_data["speaker"],
         sentence_data["text"], sentence_data["start"],
         sentence_data["end"], sentence_data["confidence"])
    )
    conn.commit()
    conn.close()
```

## Related MeetStream documentation

- Create Bot with Live Transcription: https://docs.meetstream.ai/guides/transcription-recordings/create-bot-with-live-transcription
- Webhooks and Events: https://docs.meetstream.ai/guides/webhooks/webhooks-and-events
- Real-time Audio Streaming: https://docs.meetstream.ai/guides/web-sockets/real-time-audio-streaming
- MeetStream docs: https://docs.meetstream.ai

## License

This repository is MIT licensed. See LICENSE for details.
