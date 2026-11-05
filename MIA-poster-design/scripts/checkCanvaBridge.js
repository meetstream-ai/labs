import dotenv from 'dotenv';
import { createCanvaBridge } from '../src/canvaBridge.js';
import { startWebhookServer } from '../src/webhookServer.js';

dotenv.config({ quiet: true });
const bridge = createCanvaBridge(process.env.MEETSTREAM_API_KEY);
const server = await startWebhookServer(3456, () => {}, bridge.handle);
const call = async (body) => {
  const response = await fetch('http://127.0.0.1:3456/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bridge.secret}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify(body)
  });
  return response.status === 202 ? null : response.json();
};

try {
  const initialized = await call({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mia-check', version: '1' } }
  });
  if (initialized.error) throw new Error(initialized.error.message);
  await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const listed = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  if (listed.result?.tools?.map((tool) => tool.name).join(',') !== 'generate-design') {
    throw new Error('generate-design is unavailable.');
  }
  console.log('Canva bridge verified: generate-design');
} finally {
  bridge.close();
  await new Promise((resolve) => server.close(resolve));
}
