const BOT_URL = 'https://api.meetstream.ai/api/v1/bots/create_bot';
const MIA_URL = 'https://api.meetstream.ai/api/v1/mia';
const WAKE_WORDS = [
  'hey assistant', 'okay assistant', 'ok assistant', 'here assistant',
  'hey bot', 'okay bot', 'ok bot', 'hey bought', 'okay bought',
  'hey bud', 'okay bud', 'ok bud'
];
const WAKE_WORD_TIMEOUT_SECONDS = 8;
// Bot removal is capped: at most REMOVAL_MAX_ATTEMPTS rounds, each waiting
// REMOVAL_WAIT_MS for the bot.stopped webhook (18 x 5 s = 90 s), then give up.
const REMOVAL_MAX_ATTEMPTS = 18;
const REMOVAL_WAIT_MS = 5000;
const REMOVAL_TIMEOUT_SECONDS = (REMOVAL_MAX_ATTEMPTS * REMOVAL_WAIT_MS) / 1000;
const WAKE_WORD_SYSTEM_PROMPT = `You are MIA, a concise meeting assistant in a live meeting. Respond in meeting chat whenever the user directly addresses you with ${WAKE_WORDS.join(', ')}. Treat punctuation and the words bot and bought as equivalent. The activation phrase and question may arrive together or in consecutive turns. Answer briefly in plain text. When asked to summarize, summarize the meeting context available in this session, including decisions and action items. Ignore conversation not addressed to you. Never guess.`;
const ACTIVE_SYSTEM_PROMPT = 'You are MIA, a concise meeting assistant in a live meeting. The MeetStream wake-word gate has already activated you, so answer the current request briefly in meeting chat. When asked to summarize, summarize the meeting context available in this session, including decisions and action items. Never guess.';
const BYPASS_SYSTEM_PROMPT = 'You are MIA, a concise meeting assistant in a live meeting. Diagnostic bypass mode is active: respond in meeting chat to every final transcript without requiring a wake word. Answer briefly in plain text. When asked to summarize, summarize the meeting context available in this session, including decisions and action items. Never guess.';

export async function verifyMiaConfig(apiKey, agentConfigId) {
  const url = new URL(MIA_URL);
  url.searchParams.set('agent_config_id', agentConfigId);
  const response = await fetch(url, {
    headers: { Authorization: `Token ${apiKey}` }
  }).catch(() => {
    throw new Error('Could not check the MeetStream Hosted Agent.');
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(formatApiError(response.status, data.message || data.error));
  const agentConfig = data.agent_config || data;
  console.log(JSON.stringify(agentConfig, null, 2));
  return agentConfig;
}

export async function updateMiaConfig(apiKey, agentConfigId, changes) {
  const response = await fetch(MIA_URL, {
    method: 'PUT',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ agent_config_id: agentConfigId, ...changes })
  }).catch(() => {
    throw new Error('Could not update the MeetStream Hosted Agent.');
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(formatApiError(response.status, data.message || data.error));
  return data.agent_config || data;
}

export async function configureWakeWordBypass(apiKey, agentConfigId, agent, enabled) {
  const nativeWakeWord = agent.Mode === 'pipeline' && !enabled;
  const systemPrompt = enabled ? BYPASS_SYSTEM_PROMPT : nativeWakeWord ? ACTIVE_SYSTEM_PROMPT : WAKE_WORD_SYSTEM_PROMPT;
  const changes = {
    model: { ...agent.Model, system_prompt: systemPrompt }
  };
  if (agent.Mode === 'pipeline') {
    changes.agent = {
      ...agent.Agent,
      response_type: 'chat',
      response_modality: 'chat'
    };
    changes.wake_word = nativeWakeWord
      ? { enabled: true, words: WAKE_WORDS, timeout: WAKE_WORD_TIMEOUT_SECONDS }
      : { enabled: false };
    if (nativeWakeWord) {
      changes.transcriber = {
        ...agent.Transcriber,
        provider: 'deepgram',
        model: 'nova-3',
        language: 'en',
        boostwords: WAKE_WORDS
      };
    }
  }
  const updated = await updateMiaConfig(apiKey, agentConfigId, {
    ...changes
  });
  return updated.Model || updated.model;
}

export async function validateAgentConfig(apiKey, agentConfigId) {
  const response = await fetch(MIA_URL, {
    headers: { Authorization: `Token ${apiKey}` }
  }).catch(() => {
    throw new Error('Could not check the MeetStream Hosted Agent.');
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(formatApiError(response.status, data.message || data.error));
  const agent = data.agent_configs?.find((item) => item.AgentConfigID === agentConfigId);
  if (!agent) throw new Error('MEETSTREAM_AGENT_CONFIG_ID does not match a saved Hosted Agent.');
  if (!['pipeline', 'realtime'].includes(agent.Mode)) {
    throw new Error('The Hosted Agent mode must be Pipeline or Realtime.');
  }
  if (agent.Agent?.response_type !== 'chat' && agent.Agent?.response_modality !== 'chat') {
    throw new Error('The Hosted Agent response type must be Chat. Save it in MeetStream Dashboard > Agents.');
  }
  if (agent.Mode === 'realtime' && agent.Model?.provider === 'openai' &&
      !['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].includes(agent.Model.voice)) {
    throw new Error(`The OpenAI Realtime voice "${agent.Model?.voice || 'missing'}" is not supported.`);
  }
  if (agent.Mode === 'pipeline') {
    if (!agent.Transcriber || !agent.Voice) {
      throw new Error('The Pipeline Agent needs both transcription and voice settings.');
    }
    if (agent.WakeWord?.enabled && !agent.WakeWord.words?.length) {
      throw new Error('Add activation phrases to the enabled native wake-word settings.');
    }
  }
  return agent;
}

function formatApiError(status, message = '') {
  const explanations = {
    400: 'MeetStream rejected the bot settings.',
    403: 'MeetStream denied access. Check MEETSTREAM_API_KEY.',
    404: 'MeetStream could not find the requested bot.',
    405: 'MeetStream rejected the request method.',
    500: 'MeetStream had a server error. Try again shortly.'
  };
  return `${explanations[status] || `MeetStream returned error ${status}.`}${message ? ` ${message}` : ''}`;
}

export async function deployBot({ apiKey, agentConfigId, meetingLink, callbackUrl }) {
  const payload = {
    meeting_link: meetingLink,
    bot_name: 'Meeting Summary Bot',
    bot_message: "Hi, I'm MIA Chat Bot. Ask me a question or ask me to summarize the meeting.",
    // Audio only. `false` is sent explicitly because the REST API treats an
    // omitted `video_required` as true. Video is opt-in, and when it is on
    // the payload must also carry recording_config.video_layout: "speaker_view".
    video_required: false,
    agent_config_id: agentConfigId
  };
  if (callbackUrl) {
    payload.callback_url = callbackUrl;
  }

  const response = await fetch(BOT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  }).catch(() => {
    throw new Error('Could not connect to MeetStream. Check your internet connection and try again.');
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(formatApiError(response.status, data.message || data.error));
  if (!data.bot_id) throw new Error('MeetStream deployed the bot but did not return its ID, so it cannot be stopped safely.');
  return data;
}

export async function removeBot(apiKey, botId, waitForTerminal) {
  if (!waitForTerminal) throw new Error('Bot removal requires webhook confirmation.');
  const headers = { Authorization: `Token ${apiKey}` };
  const baseUrl = `https://api.meetstream.ai/api/v1/bots/${encodeURIComponent(botId)}`;

  for (let attempt = 1; attempt <= REMOVAL_MAX_ATTEMPTS; attempt++) {
    const response = await fetch(`${baseUrl}/remove_bot`, {
      method: 'GET',
      headers
    }).catch(() => null);
    if (response && !response.ok && response.status !== 404) {
      const data = await response.json().catch(() => ({}));
      throw new Error(formatApiError(response.status, data.message || data.error));
    }

    try {
      await waitForTerminal(botId, REMOVAL_WAIT_MS);
      return;
    } catch {
      const statusResponse = await fetch(`${baseUrl}/detail`, { headers }).catch(() => null);
      const details = statusResponse?.ok
        ? (await statusResponse.json().catch(() => ({}))).bot_details
        : null;
      const timeline = details?.StatusTimeline || {};
      if (timeline.Stopped?.status || timeline.Kicked?.status ||
          ['stopped', 'mediaprocessing', 'done', 'mediaexpired', 'failed', 'error', 'notallowed', 'denied']
            .includes(String(details?.Status ?? '').toLowerCase())) return;
      if (attempt < REMOVAL_MAX_ATTEMPTS) {
        console.log(`⏳ Still waiting for MeetStream to confirm removal (attempt ${attempt}/${REMOVAL_MAX_ATTEMPTS})`);
      }
    }
  }

  throw new Error(`MeetStream did not confirm bot removal after ${REMOVAL_TIMEOUT_SECONDS} seconds (${REMOVAL_MAX_ATTEMPTS} attempts). Remove the bot from the dashboard or the meeting.`);
}
