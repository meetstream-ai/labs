"""E2E: live-captions serve + join against the mock; second pass with a webhook secret set."""
import os, re, subprocess, sys, tempfile, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'mock-meetstream'))
from e2e_common import *
APP = os.path.abspath(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(APP, '.venv', 'bin', 'live-captions')


def run(secret):
    mp, port = start_mock(tempfile.mktemp(suffix='.jsonl'), {'MOCK_TUNNEL': '1'})
    cp = free_port()
    env = dict(os.environ, MEETSTREAM_API_KEY='test-key', MEETSTREAM_BASE_URL='http://127.0.0.1:%d/api/v1' % port,
               PUBLIC_BASE_URL='https://127.0.0.1:%d' % cp, CAPTIONS_PORT=str(cp), CAPTIONS_COLOR='0',
               MEETSTREAM_WEBHOOK_SECRET=secret)
    out = tempfile.NamedTemporaryFile('w+', delete=False)
    srv = subprocess.Popen([BIN, 'serve'], env=env, cwd=tempfile.gettempdir(), stdout=out, stderr=subprocess.STDOUT)
    time.sleep(2.5)
    j = subprocess.run([BIN, 'join', '--yes', 'https://meet.google.com/abc-defg-hij'], env=env, cwd=tempfile.gettempdir(),
                       capture_output=True, text=True)
    print(j.stdout.strip(), j.stderr.strip()[-300:])
    m = re.search(r'Bot ([0-9a-f-]{36})', j.stdout)
    if m:
        mock_call(port, 'POST', '/__mock/simulate/' + m.group(1))
    time.sleep(1.5)
    srv.terminate(); srv.wait()
    printed = open(out.name).read()
    print('--- serve output ---'); print(printed[-1500:])
    log = summarize(port); mp.kill()
    return printed, log


printed, _ = run('')
ok1 = 'Ana' in printed and 'Ben' in printed and 'release notes' in printed
printed2, log2 = run('whsec_test')
rejected = [e for e in log2 if e.get('outbound') in ('live_transcript', 'callback_url') and e.get('status') == 401]
print('E2E no-secret', 'PASS' if ok1 else 'FAIL')
print('E2E with-secret: unsigned deliveries rejected with 401:', len(rejected))
