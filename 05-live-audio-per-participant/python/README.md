# meetstream-live-audio-per-participant

This repository demonstrates how to use MeetStream.ai's live per-participant
audio streaming feature. It deploys a MeetStream bot into a Google Meet, Zoom,
or Microsoft Teams meeting, connects a local WebSocket server to receive live
binary audio frames from the bot, decodes MeetStream's custom binary frame
format, and accumulates audio separately for each speaker. When the meeting
ends, the developer gets one WAV file per participant, each containing only
that participant's voice.

## How it works

1. A MeetStream bot joins the meeting.
2. The bot opens a WebSocket connection to your local server.
3. The bot sends binary audio frames continuously, one per audio chunk.
4. Each frame contains the speaker's ID, display name, and raw PCM audio.
5. The server separates frames by speaker_id and accumulates audio per speaker.
6. When the meeting ends and the bot disconnects, one WAV file is saved per speaker.

```
Frame structure:
[1 byte]  msg_type     - always 0x01 for PCM audio
[2 bytes] sid_length   - byte length of speaker_id (uint16 little-endian)
[N bytes] speaker_id   - platform-specific speaker identifier (UTF-8)
[2 bytes] sname_length - byte length of speaker_name (uint16 little-endian)
[M bytes] speaker_name - display name shown in the meeting (UTF-8)
[rest]    pcm_audio    - raw PCM16 little-endian audio at 48000 Hz mono
```

## Prerequisites

- Python 3.9 or higher
- A MeetStream account and API key (sign up at app.meetstream.ai)
- ngrok installed and authenticated (download at ngrok.com/download)
- A Google Meet meeting link (Zoom and Microsoft Teams are also supported)

## Setup

1. Navigate to the python directory

From the root of the meetstream-sample-apps repository:

```
cd sample-apps/05-live-audio-per-participant/python
```

2. Install dependencies

```
pip install -r requirements.txt
```

3. Configure environment variables

```
cp .env.example .env
```

Then open .env and fill in your MEETSTREAM_API_KEY and MEETING_LINK.

4. Start the WebSocket server

Open a terminal window and run:

```
python audio_server.py
```

You should see:

```
MeetStream Live Audio Server
Listening on ws://0.0.0.0:8765
Output directory: /your/path/output
Waiting for bot connection...
```

5. Start the ngrok tunnel

Open a second terminal window and run:

```
ngrok http 8765 --host-header="localhost:8765"
```

Copy the Forwarding URL from the output. It will look like:

```
Forwarding    https://abc123.ngrok-free.app -> http://localhost:8765
```

Your WebSocket URL is the same domain with wss:// instead of https://:

```
wss://abc123.ngrok-free.app
```

6. Update the WebSocket URL in create_bot.py

Open create_bot.py and replace the WEBSOCKET_URL placeholder with your ngrok URL:

```python
WEBSOCKET_URL = "wss://abc123.ngrok-free.app"
```

7. Create the bot

Open a third terminal window and run:

```
python create_bot.py
```

You should see:

```
Bot created successfully
Bot ID:      f8025eaa-6b0d-48b9-b2a5-d085befa9b83
Meeting URL: https://meet.google.com/your-meeting-link
Status:      Active

Admit the bot in your meeting to start receiving audio.
```

8. Admit the bot in your meeting

Open the meeting link in your browser. The bot named "MeetStream Audio Bot"
will appear in the waiting room. Click Admit to let it join.

## Expected output

Terminal 1 (audio_server.py):

```
Bot connected, waiting for audio frames...
Handshake received - Bot ID: f8025eaa-6b0d-48b9-b2a5-d085befa9b83
New speaker detected: Borgir Varshanraman (user_abc123)
[Borgir Varshanraman] frame: 9600 bytes | total: 0.1s
[Borgir Varshanraman] frame: 9600 bytes | total: 0.2s
New speaker detected: Divya Sharma (user_def456)
[Divya Sharma] frame: 9600 bytes | total: 0.1s
[Borgir Varshanraman] frame: 9600 bytes | total: 0.3s
...
Bot disconnected. Saving per-speaker WAV files...
Saved: Borgir_Varshanraman_user_abc1.wav (4.5 seconds)
Saved: Divya_Sharma_user_def4.wav (2.1 seconds)

Session summary:
  Borgir Varshanraman: 4.5 seconds of audio captured
  Divya Sharma: 2.1 seconds of audio captured

Files saved to: /your/path/output
```

Output folder after the meeting:

```
output/
  Borgir_Varshanraman_user_abc1.wav
  Divya_Sharma_user_def4.wav
```

## Audio properties

| Property    | Value                    |
|-------------|--------------------------|
| Format      | WAV                      |
| Encoding    | Signed 16-bit PCM        |
| Sample rate | 48000 Hz                 |
| Channels    | 1 (mono)                 |
| Byte order  | Little-endian            |

## Troubleshooting

### Issue 1: InvalidUpgrade or "missing Connection header" error in audio_server.py terminal

Symptom:

```
websockets.exceptions.InvalidUpgrade: missing Connection header
```

Cause: ngrok is sending HTTP health check requests to your WebSocket server.
These are not WebSocket upgrade requests and the websockets library rejects them.

Fix: Restart ngrok with the --host-header flag:

```
ngrok http 8765 --host-header="localhost:8765"
```

### Issue 2: Bot is created but no audio frames appear in audio_server.py

Symptom: The bot creation script returns successfully but the audio server
shows nothing after "Waiting for bot connection...".

Cause: The bot was not admitted into the meeting, or the WEBSOCKET_URL in
create_bot.py still contains the placeholder value.

Fix: Confirm the WEBSOCKET_URL in create_bot.py starts with wss:// and matches
your current ngrok forwarding URL exactly. Then open the meeting link in your
browser and click Admit when the bot appears in the waiting room.

### Issue 3: All frames show "NoSpeaker" and no WAV files are saved

Symptom: The server prints frames but every line shows "NoSpeaker" and no
files appear in the output/ folder.

Cause: This happens in the first few seconds of a meeting while the platform
is still resolving participant identities. It can also happen during silence
when no speaker is detected.

Fix: This is expected behaviour for the first 5 to 10 seconds. Keep speaking
and the speaker attribution will populate. Frames with "NoSpeaker" are
automatically skipped and do not affect the saved audio.

### Issue 4: audio_server.py exits immediately with no error

Symptom: Running python audio_server.py returns to the command prompt immediately.

Cause: The websockets library is not installed, or the wrong version of Python
is being used.

Fix: Confirm your Python version is 3.9 or higher:

```
python --version
```

Then reinstall dependencies:

```
pip install -r requirements.txt
```

## Platform support

Live audio streaming works on Google Meet, Zoom, and Microsoft Teams using the
same payload and the same binary frame format across all three platforms.

## Related MeetStream documentation

- MeetStream docs: https://docs.meetstream.ai
- Create Bot with Per Participant Audio: https://docs.meetstream.ai/guides/transcription-recordings/create-bot-with-per-participant-audio
- Real-time Audio Streaming: https://docs.meetstream.ai/guides/web-sockets/real-time-audio-streaming
- Bot Lifecycle Webhook Events: https://docs.meetstream.ai/guides/webhooks/webhooks-and-events

## License

This repository is MIT licensed. See LICENSE for details.
