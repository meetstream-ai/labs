// Opt-in live API contract check. No meeting bot is created.
import { MeetStream, miaConfig } from '../src/meetstream.js';
const ms = new MeetStream(process.env.MEETSTREAM_API_KEY, process.env.MEETSTREAM_BASE_URL);
if (!ms.key) throw new Error('MEETSTREAM_API_KEY required');
const before = await ms.request('/mia');
console.log('MIA list:', Array.isArray(before.agent_configs) ? 'OK' : 'unexpected response shape');
if (process.argv.includes('--register')) {
  let id;
  const probeName = 'contract-probe-' + Date.now();
  try {
    const config = miaConfig('https://example.com', 'test-only-not-a-real-bridge-token', probeName);
    const created = await ms.request('/mia', 'POST', config);
    id = created.agent_config_id;
    if (!id) throw new Error('Missing agent_config_id');
    const saved = await ms.request('/mia?agent_config_id=' + encodeURIComponent(id));
    console.log(
      'MIA registration and retrieval:',
      saved.agent_config ? 'OK' : 'unexpected response shape',
    );
  } finally {
    if (!id) {
      const rows = (await ms.request('/mia')).agent_configs || [];
      const owned = rows.find((r) => r.AgentName === 'DeepSeek bridge ' + probeName);
      id = owned?.AgentConfigID;
    }
    if (id) {
      await ms.request('/mia?agent_config_id=' + encodeURIComponent(id), 'DELETE');
      console.log('Owned probe configuration deleted');
    }
  }
}
