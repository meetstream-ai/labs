"""E2E: dispatch-bots against the mock with bad links and a 3-per-minute rate limit (429 + Retry-After)."""
import os, subprocess, sys, tempfile, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'mock-meetstream'))
from e2e_common import *
APP = os.path.abspath(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(APP, '.venv', 'bin', 'dispatch-bots')
mp, port = start_mock(tempfile.mktemp(suffix='.jsonl'), {'MOCK_RATE_LIMIT_PER_MIN': '3'})
links = tempfile.mktemp(suffix='.txt')
open(links, 'w').write('\n'.join([
    'https://meet.google.com/abc-defg-hij',
    'https://us02web.zoom.us/j/81234567890?pwd=abc',
    'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d',
    'https://meet.google.com/xyz-abcd-efg',
    'https://zoom.us/my/johnsroom',
    'https://example.com/not-a-meeting',
    'https://zoom.us/j/abc',
]) + '\n')
env = dict(os.environ, MEETSTREAM_API_KEY='test-key', MEETSTREAM_BASE_URL='http://127.0.0.1:%d/api/v1' % port, MEETSTREAM_MAX_BACKOFF='70', PYTHONWARNINGS='ignore')
t = time.time()
r = subprocess.run([CLI, links, '--concurrency', '2'], cwd=tempfile.gettempdir(), env=env, capture_output=True, text=True, timeout=110)
print('rc', r.returncode, 'took %.0fs' % (time.time() - t)); print((r.stdout + r.stderr)[-2500:])
log = summarize(port); mp.kill()
created = [e for e in log if e.get('path') == '/api/v1/bots/create_bot' and e.get('status') == 201]
got429 = [e for e in log if e.get('path') == '/api/v1/bots/create_bot' and e.get('status') == 429]
print('created', len(created), '429s', len(got429))
print('E2E', 'PASS' if len(created) == 4 and got429 else 'FAIL')
