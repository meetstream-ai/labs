// Deterministic offline demonstration. This is not a live DeepSeek or meeting recording.
import { Store } from '../src/store.js';
import { Bridge } from '../src/bridge.js';
const store = new Store(':memory:');
const logs = [];
let runs = 0;
const bridge = new Bridge(
  store,
  {
    run: async ({ prompt, mode, onSession }) => {
      runs++;
      onSession('demo-' + mode);
      return mode === 'read-only'
        ? 'The parser is in src/parser.js.'
        : 'Finding: empty input indexes past the array. Suggested fix: return early. Demo fixture only.';
    },
  },
  {
    notify: async (s, m) => {
      logs.push(m);
      console.log('Meeting chat:', m);
    },
  },
);
const s = bridge.create({ repo: '/demo/repo', meetingUrl: 'offline://demo' });
bridge.context(s.id, {
  id: 'transcript-1',
  speaker: 'Alice',
  text: 'Empty input crashes the parser.',
  final: true,
});
console.log('Alice: DeepSeek, investigate that parser crash.');
const request = {
  requestId: 'spoken-request-1',
  text: 'Investigate the parser crash on empty input.',
  kind: 'engineering',
};
const task = bridge.submit(s.id, request);
console.log('Proposed task:', task.id, task.status);
console.log('Retry refers to same task:', bridge.submit(s.id, request).id === task.id);
console.log('Operator approves exact task:', task.id);
bridge.approve(s.id, task.id);
await bridge.running.get(task.id).promise;
console.log('Task status:', bridge.task(s.id, task.id).status, 'Agent runs:', runs);
await bridge.close(s.id);
console.log('Session closed; pending work cancelled.');
store.close();
