// A local stand-in for the MeetStream API. The client is pointed at it with
// MEETSTREAM_BASE_URL, so tests exercise the real request code with no network.

import http from 'node:http';

/**
 * respond(call) -> [status, body, delayMs?] is the default behaviour. A test replaces
 * one route with `mock.overrides["METHOD /path"] = (call) => [status, body]`.
 */
export async function startMock(respond) {
  const mock = { calls: [], overrides: {}, close: null };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://mock');
      const call = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined
      };
      mock.calls.push(call);
      const handler = mock.overrides[`${call.method} ${call.path}`] ?? respond;
      const [status, body, delayMs = 0] = await handler(call);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const saved = process.env.MEETSTREAM_BASE_URL;
  process.env.MEETSTREAM_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  mock.close = async () => {
    if (saved === undefined) delete process.env.MEETSTREAM_BASE_URL;
    else process.env.MEETSTREAM_BASE_URL = saved;
    await new Promise((resolve) => server.close(resolve));
  };
  return mock;
}
