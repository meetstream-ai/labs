import { describe, expect, it } from 'vitest';
import {
  MeetStreamClient,
  MeetStreamError,
  TranscriptNotReadyError,
} from '../src/meetstream/client.js';
import { SAMPLE_TRANSCRIPT, stubFetch } from './helpers.js';

function client(fetchImpl: ReturnType<typeof stubFetch>['fetchImpl']) {
  return new MeetStreamClient({
    apiKey: 'test-key',
    baseUrl: 'https://api.example.invalid/api/v1',
    fetchImpl,
  });
}

describe('MeetStreamClient.createBot', () => {
  it('sends an audio-only bot with the callback and transcript config', async () => {
    const { fetchImpl, requests } = stubFetch({
      'POST /bots/create_bot': { json: { bot_id: 'bot_123' } },
    });

    const botId = await client(fetchImpl).createBot({
      meetingLink: 'https://meet.google.com/abc-defg-hij',
      callbackUrl: 'https://notetaker.example.invalid/webhook/meetstream/tok',
      botName: 'Notetaker',
      transcriptProvider: 'deepgram',
      language: 'en',
      customAttributes: { tenant: 42 as unknown as string },
    });

    expect(botId).toBe('bot_123');
    expect(requests).toHaveLength(1);

    const request = requests[0]!;
    expect(request.url).toBe('https://api.example.invalid/api/v1/bots/create_bot');
    expect(new Headers(request.init?.headers).get('Authorization')).toBe('Token test-key');

    const body = JSON.parse(String(request.init?.body));
    expect(body.meeting_link).toBe('https://meet.google.com/abc-defg-hij');
    expect(body.video_required).toBe(false);
    expect(body.callback_url).toBe('https://notetaker.example.invalid/webhook/meetstream/tok');
    expect(body.recording_config.transcript.provider).toEqual({
      deepgram: { model: 'nova-3', language: 'en' },
    });
    expect(body.recording_config.retention).toEqual({ type: 'timed', hours: 168 });
    expect(body.automatic_leave.waiting_room_timeout).toBe(600);
    // custom_attributes values must be strings
    expect(body.custom_attributes).toEqual({ tenant: '42' });
  });

  it('sends both required fields for the keyless meetstream provider', async () => {
    const { fetchImpl, requests } = stubFetch({
      'POST /bots/create_bot': { json: { bot_id: 'bot_123' } },
    });

    await client(fetchImpl).createBot({
      meetingLink: 'https://meet.google.com/abc-defg-hij',
      callbackUrl: 'https://notetaker.example.invalid/hook',
      botName: 'Notetaker',
      transcriptProvider: 'meetstream',
      language: 'en',
    });

    const body = JSON.parse(String(requests[0]!.init?.body));
    expect(body.recording_config.transcript.provider).toEqual({
      meetstream: { language: 'en', translate: false },
    });
  });

  it('raises a MeetStreamError on a non-2xx', async () => {
    const { fetchImpl } = stubFetch({
      'POST /bots/create_bot': { status: 401, body: 'unauthorized' },
    });

    await expect(
      client(fetchImpl).createBot({
        meetingLink: 'https://meet.google.com/abc-defg-hij',
        callbackUrl: 'https://notetaker.example.invalid/hook',
        botName: 'Notetaker',
        transcriptProvider: 'deepgram',
        language: 'en',
      }),
    ).rejects.toThrow(MeetStreamError);
  });
});

describe('MeetStreamClient.getTranscript', () => {
  it('resolves transcript_id from bot detail, then fetches the transcript', async () => {
    const { fetchImpl, requests } = stubFetch({
      'GET /bots/bot_123/detail': { json: { bot_details: { transcript_id: 'tr_9' } } },
      'GET /transcript/tr_9/get_transcript': { json: SAMPLE_TRANSCRIPT },
    });

    const segments = await client(fetchImpl).getTranscript('bot_123');

    expect(segments).toEqual(SAMPLE_TRANSCRIPT);
    expect(requests.map((request) => request.url)).toEqual([
      'https://api.example.invalid/api/v1/bots/bot_123/detail',
      'https://api.example.invalid/api/v1/transcript/tr_9/get_transcript',
    ]);
  });

  it('signals not-ready when the transcript returns 202', async () => {
    const { fetchImpl } = stubFetch({
      'GET /bots/bot_123/detail': { json: { bot_details: { transcript_id: 'tr_9' } } },
      'GET /transcript/tr_9/get_transcript': { status: 202, body: '' },
    });

    await expect(client(fetchImpl).getTranscript('bot_123')).rejects.toThrow(
      TranscriptNotReadyError,
    );
  });

  it('signals not-ready when there is no transcript_id yet', async () => {
    const { fetchImpl } = stubFetch({
      'GET /bots/bot_123/detail': { json: { bot_details: {} } },
    });

    await expect(client(fetchImpl).getTranscript('bot_123')).rejects.toThrow(
      TranscriptNotReadyError,
    );
  });

  it('raises when the provider marked the transcript failed', async () => {
    const { fetchImpl } = stubFetch({
      'GET /bots/bot_123/detail': {
        json: { bot_details: { TranscriptStatus: 'Failed', transcript_id: 'tr_9' } },
      },
    });

    await expect(client(fetchImpl).getTranscript('bot_123')).rejects.toThrow(MeetStreamError);
  });
});
