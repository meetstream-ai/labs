import os, subprocess, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'mock-meetstream'))
from e2e_common import *
APP = os.path.abspath(os.path.dirname(os.path.abspath(__file__)))
mp, port = start_mock(tempfile.mktemp(suffix='.jsonl'))
import urllib.request, json
def api(path, body):
    r = urllib.request.Request('http://127.0.0.1:%d/api/v1%s' % (port, path), data=json.dumps(body).encode(),
                               headers={'Authorization': 'Token t', 'Content-Type': 'application/json'})
    return json.loads(urllib.request.urlopen(r).read())
b1 = api('/bots/create_bot', {'meeting_link': 'https://meet.google.com/abc-defg-hij', 'video_required': True, 'audio_separate_streams': True})
b2 = api('/bots/create_bot', {'meeting_link': 'https://meet.google.com/xyz-defg-hij'})
b3 = api('/bots/create_bot', {'meeting_link': 'https://meet.google.com/qqq-defg-hij'})  # still in progress
for b in (b1, b2):
    mock_call(port, 'POST', '/__mock/simulate/' + b['bot_id'])
out = tempfile.mkdtemp()
env = dict(os.environ, MEETSTREAM_API_KEY='test-key', MEETSTREAM_BASE_URL='http://127.0.0.1:%d/api/v1' % port, ARCHIVE_DIR=out)
r = subprocess.run([os.path.join(APP, '.venv/bin/recording-archiver')], env=env, cwd=out, capture_output=True, text=True)
print(r.returncode, r.stdout[-2000:], r.stderr[-1500:])
files = sorted(os.path.relpath(os.path.join(d, f), out) for d, _, fs in os.walk(out) for f in fs)
print('\n'.join(files))
summarize(port); mp.kill()
ok = any(b1['bot_id'] in f and 'video' in f for f in files) and sum(1 for f in files if b1['bot_id'] in f) >= 4 and any(b2['bot_id'] in f for f in files) and not any(b3['bot_id'] in f and not f.endswith('manifest.json') for f in files)
print('E2E', 'PASS' if ok else 'FAIL')
