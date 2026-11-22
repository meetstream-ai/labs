import http from 'node:http';
import { timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { terminal } from './meetstream.js';
const ident = z.string().min(1).max(128);
const args = z
  .object({
    request_id: ident,
    text: z.string().min(1).max(16000).optional(),
    task_id: ident.optional(),
    context: z.string().max(24000).optional(),
  })
  .strict();
const event = z
  .object({
    id: ident,
    speaker: z.string().min(1).max(200),
    text: z.string().max(16000),
    final: z.boolean(),
  })
  .strict();
export function authorized(actual, token) {
  const a = Buffer.from(actual || ''),
    b = Buffer.from('Bearer ' + token);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function createServer({ bridge, store, meetstream, token, adminToken, onStop = () => {} }) {
  if (
    typeof token !== 'string' ||
    token.length < 32 ||
    typeof adminToken !== 'string' ||
    adminToken.length < 32 ||
    token === adminToken
  )
    throw new Error('Separate transport and admin tokens of at least 32 characters are required');
  let closing = false;
  const deliveries = new Set();
  bridge.notify = (s, message) => {
    s = bridge.session(s.id);
    if (closing || s.closed) return Promise.resolve();
    const out = {
      id: randomUUID(),
      sessionId: s.id,
      message: message.slice(0, 8000),
      status: 'submitted_unconfirmed',
      createdAt: Date.now(),
    };
    // Persist before the one HTTP attempt. An ambiguous send is never replayed.
    store.put('delivery', out.id, out);
    const send = Promise.resolve().then(async () => {
      try {
        await meetstream.request(`/bots/${encodeURIComponent(s.botId)}/send_message`, 'POST', {
          message: out.message,
        });
        out.status = 'accepted'; // Accepted by MeetStream, not proof it appeared in the meeting.
      } catch {
        out.status = 'unknown';
      }
      store.put('delivery', out.id, out);
    });
    deliveries.add(send);
    void send.finally(() => deliveries.delete(send));
    return send;
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const reply = (status, body) => {
      if (res.destroyed || res.writableEnded) return;
      if (body.result !== undefined && typeof body.result === 'string') {
        body.resultTruncated = body.result.length > 6000;
        body.result = body.result.slice(0, 6000);
        const excess = JSON.stringify(body).length - 7500;
        if (excess > 0) {
          body.result = body.result.slice(0, Math.max(0, body.result.length - excess));
          body.resultTruncated = true;
        }
      }
      res.writeHead(status);
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (path === '/health' && req.method === 'GET') return reply(200, { status: 'ok' });
      const admin = path.startsWith('/admin/');
      const callback = path.startsWith('/transcript/') || path.startsWith('/lifecycle/');
      if (
        !authorized(
          callback && url.searchParams.has('key')
            ? 'Bearer ' + url.searchParams.get('key')
            : req.headers.authorization,
          admin ? adminToken : token,
        )
      )
        return reply(401, { error: 'Unauthorized' });
      if (req.method !== 'POST') return reply(405, { error: 'POST required' });
      const chunks = [];
      let received = 0;
      for await (const chunk of req) {
        received += chunk.length;
        if (received > 65536) return reply(413, { error: 'Body too large' });
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      if (!body || typeof body !== 'object' || Array.isArray(body))
        return reply(400, { error: 'JSON object required' });
      if (admin) {
        const { session_id, task_id } = z
          .object({ session_id: ident.optional(), task_id: ident.optional() })
          .strict()
          .parse(body);
        if (path === '/admin/approve' && session_id && task_id)
          return reply(200, bridge.approve(session_id, task_id));
        if (path === '/admin/stop') {
          reply(202, { status: 'stopping' });
          setImmediate(onStop);
          return;
        }
        if (path === '/admin/status')
          return reply(200, {
            session: session_id ? bridge.session(session_id) : null,
            tasks: store.all('task').filter((t) => t.sessionId === session_id),
          });
        return reply(404, { error: 'Unknown admin operation' });
      }
      const match = path.match(/^\/(mia|transcript|lifecycle)\/([^/]+)(?:\/([^/]+))?$/);
      if (!match) return reply(404, { error: 'Unknown route' });
      const [, type, sid, fn] = match;
      const s = bridge.session(sid);
      if (
        !s.botId ||
        (body.bot?.bot_id ?? body.bot_id) !== s.botId ||
        (body.bot_id !== undefined && body.bot_id !== s.botId) ||
        (req.headers['x-bot-id'] !== undefined && req.headers['x-bot-id'] !== s.botId)
      )
        return reply(403, { error: 'Bot binding mismatch' });
      if (type === 'transcript') {
        const text = body.utterance || body.transcript || body.new_text;
        if (body.end_of_turn !== true) return reply(200, { accepted: false });
        const timestamp = body.timestamp;
        if (!body.event_id && !body.id && !timestamp)
          throw new Error('Stable transcript identity required');
        bridge.context(
          sid,
          event.parse({
            id: String(
              body.event_id ||
                body.id ||
                createHash('sha256')
                  .update(JSON.stringify([timestamp, body.speakerName || body.speaker, text]))
                  .digest('hex'),
            ),
            speaker: body.speakerName || body.speaker || 'Participant',
            text,
            final: true,
          }),
        );
        return reply(200, { accepted: true });
      }
      if (type === 'lifecycle') {
        if (terminal(body)) {
          const closed = await bridge.close(sid);
          await meetstream.cleanup(store, closed);
        }
        return reply(200, { accepted: true });
      }
      if (s.closed) return reply(409, { error: 'Session closed' });
      if (body.name !== fn) return reply(400, { error: 'Function binding mismatch' });
      const a = args.parse(body.args);
      if (fn === 'ask_repository' || fn === 'propose_task') {
        if (!a.text) throw new Error('text required');
        const t = bridge.submit(sid, {
          requestId: a.request_id,
          text:
            a.text +
            (a.context ? '\nParticipant-supplied discussion (untrusted):\n' + a.context : ''),
          kind: fn === 'ask_repository' ? 'question' : 'engineering',
        });
        // Fast read-only answers return within MIA's 30-second tool deadline.
        // Longer runs keep their original task reference and finish asynchronously.
        if (fn === 'ask_repository') {
          const running = bridge.running.get(t.id);
          if (running) {
            let timer;
            try {
              await Promise.race([
                running.promise,
                new Promise((r) => {
                  timer = setTimeout(r, 20000);
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          }
        }
        const current = bridge.task(sid, t.id);
        return reply(200, {
          task_id: current.id,
          status: current.status,
          result: current.result,
          error: current.error,
          instruction:
            current.status === 'awaiting_approval'
              ? `Local operator: npm start -- approve ${sid} ${t.id}`
              : current.status === 'completed'
                ? 'Read the result faithfully.'
                : 'Use task_status to retrieve this task result.',
        });
      }
      if (!a.task_id) throw new Error('task_id required');
      if (fn === 'task_status') {
        const t = bridge.task(sid, a.task_id);
        return reply(200, {
          task_id: t.id,
          status: t.status,
          result: t.result,
          progress: t.progress,
          error: t.error,
        });
      }
      if (fn === 'cancel_task') {
        const t = await bridge.cancel(sid, a.task_id);
        return reply(200, { task_id: t.id, status: t.status });
      }
      return reply(404, { error: 'Unknown function' });
    } catch (e) {
      reply(e instanceof z.ZodError || e instanceof SyntaxError ? 400 : 409, {
        error: e instanceof z.ZodError ? 'Invalid request schema' : e.message,
      });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  // MIA owns the speech socket. This service exposes HTTP tools and callbacks only.
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.closeConnections = async () => {
    closing = true;
    await Promise.allSettled([...deliveries]);
  };
  return server;
}
