# meetstream-quickstart / Python

The fastest way to get a MeetStream bot into a meeting and retrieve its transcript.
One script, two dependencies, no server required. Supports interactive mode for
development and headless mode for automation.

## How it works

1. The script creates a MeetStream bot using the REST API with your meeting link
2. The bot joins the meeting and appears in the waiting room
3. The script polls the bot status every 10 seconds
4. Once the meeting ends and the bot stops, the script fetches the transcript
5. The transcript is printed to the terminal and saved as a JSON file

## Prerequisites

- Python 3.9 or higher
- A MeetStream account and API key (sign up at app.meetstream.ai)
- A Google Meet, Zoom, or Microsoft Teams meeting link

## Setup

1. Navigate to the python directory

From the root of the meetstream-sample-apps repository:

```
cd sample-apps/01-quickstart/meetstream-quickstart/python
```

2. Install dependencies

```
pip install -r requirements.txt
```

3. Configure environment variables

```
cp .env.example .env
```

Open .env and set MEETSTREAM_API_KEY to your MeetStream API key.

## Usage - Normal mode

For development and testing where you are present to admit the bot.

Basic usage:

```
python quickstart.py "https://meet.google.com/abc-defg-hij"
```

What happens:

1. The bot is created and joins the meeting waiting room
2. The script prints "Status: Joining" and waits for you to admit the bot
3. Open the meeting in your browser and click Admit
4. The script detects the bot is Active and continues polling
5. When the meeting ends, the transcript is fetched and saved

Full expected output:

```
Creating bot...
Bot created: f8025eaa-6b0d-48b9-b2a5-d085befa9b83
Polling status every 10 seconds...
Status: Joining    <- open your meeting and admit the bot now
Status: Active
Status: Active
Status: Active
Status: Done

Meeting ended. Fetching transcript...
Waiting 30 seconds for post-processing...

[Borgir Varshanraman] Hello can everyone hear me?
[Divya Sharma] Yes loud and clear.
[Borgir Varshanraman] Great let us get started.

Transcript saved to: transcript_f8025eaa.json
Done.
```

## Usage - Headless mode

For CI pipelines, cron jobs, and automation where no human is present.

The --headless flag enables headless mode. Use --timeout to set a maximum
wait time in seconds. Use --poll-interval to change how often status is checked.

Basic headless usage:

```
python quickstart.py "https://meet.google.com/abc-defg-hij" --headless
```

With custom timeout and poll interval:

```
python quickstart.py "https://meet.google.com/abc-defg-hij" --headless --timeout 1800 --poll-interval 15
```

Full expected output in headless mode:

```
[headless] Creating bot...
[headless] Bot created: f8025eaa-6b0d-48b9-b2a5-d085befa9b83
[headless] Polling status every 10 seconds (timeout: 3600s)
[headless] Status: Joining (10s elapsed)
[headless] Status: Joining (20s elapsed)
[headless] Status: Active (30s elapsed)
[headless] Status: Active (40s elapsed)
[headless] Status: Done (120s elapsed)
[headless] Meeting ended. Waiting 30s for post-processing...
[headless] Fetching transcript...
[headless] [Borgir Varshanraman] Hello can everyone hear me?
[headless] [Divya Sharma] Yes loud and clear.
[headless] Transcript saved to: transcript_f8025eaa.json
[headless] Exiting with code 0
```

Timeout behavior:

```
[headless] Timeout reached after 3600s. Bot status was: Active
[headless] Exiting with code 1
```

Exit codes:

- 0: success, transcript saved
- 1: failure (timeout, API error, authentication failure)

CI pipeline example (GitHub Actions):

```yaml
- name: Run MeetStream quickstart
  run: |
    python quickstart.py "${{ secrets.MEETING_LINK }}" \
      --headless \
      --timeout 3600
  env:
    MEETSTREAM_API_KEY: ${{ secrets.MEETSTREAM_API_KEY }}
```

## Arguments reference

| Argument        | Type   | Default | Description                                          |
|-----------------|--------|---------|------------------------------------------------------|
| meeting_link    | string | required| The meeting URL to join                              |
| --headless      | flag   | false   | Run without interactive prompts                      |
| --timeout       | int    | 3600    | Max seconds to wait in headless mode                 |
| --poll-interval | int    | 10      | Seconds between status checks                        |

## Transcript output format

Show an example of the saved JSON file:

```json
{
  "message": [
    {
      "speaker": "Borgir Varshanraman",
      "text": "Hello can everyone hear me?",
      "start": 1.2,
      "end": 3.4
    },
    {
      "speaker": "Divya Sharma",
      "text": "Yes loud and clear.",
      "start": 4.1,
      "end": 5.8
    }
  ]
}
```

## Troubleshooting

### Issue 1: "No transcript content found"

Symptom:

```
No transcript content found. The meeting may have had no speech.
```

Cause: The meeting had very little or no speech, or the bot was removed
before it captured enough audio for transcription.

Fix: Run a fresh meeting where you speak clearly for at least 30 seconds
before removing the bot.

### Issue 2: "Transcript not ready yet" after the meeting ends

Symptom: The script repeatedly prints "Transcript not ready yet" and
eventually exits without saving a transcript.

Cause: Post-processing takes 1 to 3 minutes after the meeting ends.
For short meetings the processing may not be complete within the retry window.

Fix: Wait 2 to 3 minutes after the meeting ends and fetch the transcript
manually using the transcript_id that was printed when the bot was created.

### Issue 3: "Authentication failed" error

Symptom:

```
Authentication failed. Check your MEETSTREAM_API_KEY.
```

Cause: The API key in your .env file is missing, incorrect, or the
Authorization header format is wrong.

Fix: Confirm your .env file contains:

```
MEETSTREAM_API_KEY=your_actual_key_here
```

Do not include the word "Token" in the .env file. The script adds it automatically.

### Issue 4: Script exits immediately in headless mode

Symptom: The script prints the bot_id and then immediately exits with code 1.

Cause: The bot status returned a terminal error state immediately after creation,
such as "Fatal" or "PermissionDenied". This usually means the meeting link is
invalid or expired.

Fix: Confirm the meeting link is currently active and the meeting has not ended.
Generate a fresh meeting link and try again.

## Related MeetStream documentation

- MeetStream docs: https://docs.meetstream.ai
- Create your First Bot: https://docs.meetstream.ai/guides/get-started/create-your-first-bot
- Bot API reference: https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot
- Transcript API reference: https://docs.meetstream.ai/api-reference/api-endpoints/transcript-endpoints

## License

This repository is MIT licensed.
