# Quickstart

This bot joins your meeting and saves everything that was said into a text file once the call ends.

---

## What you need

1. [Node.js](https://nodejs.org) — click the **LTS** download button and install it
2. A MeetStream API key → [Get one here](https://app.meetstream.ai)
3. A free ngrok account → [Sign up here](https://dashboard.ngrok.com/signup) and copy your authtoken from [here](https://dashboard.ngrok.com/get-started/your-authtoken)

---

## Steps

**1. Install dependencies**
Open a terminal inside this folder and run:
```
npm install
```

**2. Create your config file**
Rename `.env.example` to `.env`, then open it and fill in your values:
```
MEETSTREAM_API_KEY=        ← paste your MeetStream API key
MEETING_LINK=              ← paste the meeting link you want the bot to join
NGROK_AUTHTOKEN=           ← paste your ngrok authtoken
```

**3. Start the bot**
```
npm start
```

The bot will join your meeting automatically. Once the meeting ends, your transcript will be saved inside a `transcripts/` folder as both a `.txt` (readable) and `.json` (raw data) file.
