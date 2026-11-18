"""E2E: notetaker serve + join against the mock, fake LLM; brief file must appear."""
import os, re, subprocess, sys, tempfile, time, glob
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'mock-meetstream'))
from e2e_common import *
APP = os.path.abspath(os.path.dirname(os.path.abspath(__file__)))
TSX = os.path.join(APP, 'node_modules', '.bin', 'tsx')
sp = free_port(); briefs = tempfile.mkdtemp()
SIGNED = os.environ.get('SIGNED') == '1'  # deliver as a signed workspace webhook instead of callback_url
menv = {'MOCK_TUNNEL': '1'}
if SIGNED:
    menv.update(MOCK_WORKSPACE_WEBHOOK_URL='https://127.0.0.1:%d/webhook/meetstream/%s' % (sp, 'a' * 64), MOCK_WEBHOOK_SECRET='whsec_test')
mp, port = start_mock(tempfile.mktemp(suffix='.jsonl'), menv)
env = dict(os.environ, MEETSTREAM_API_KEY='test-key', MEETSTREAM_BASE_URL='http://127.0.0.1:%d/api/v1' % port,
           PUBLIC_URL='https://127.0.0.1:%d' % sp, PORT=str(sp), WEBHOOK_PATH_TOKEN='a' * 64,
           LLM_PROVIDER='fake', TRANSCRIPT_PROVIDER=os.environ.get('TP', 'meetstream'), BRIEF_DIR=briefs, LOG_LEVEL='info', WEBHOOK_SIGNING_SECRET='whsec_test' if SIGNED else '')
out = tempfile.NamedTemporaryFile('w+', delete=False)
srv = subprocess.Popen([TSX, 'src/cli.ts', 'serve'], cwd=APP, env=env, stdout=out, stderr=subprocess.STDOUT)
time.sleep(4)
j = subprocess.run([TSX, 'src/cli.ts', 'join', 'https://meet.google.com/abc-defg-hij'], cwd=APP, env=env, capture_output=True, text=True)
print(j.stdout[-800:], j.stderr[-800:])
ids = re.findall(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', j.stdout + j.stderr)
if ids:
    mock_call(port, 'POST', '/__mock/simulate/' + ids[0])
time.sleep(4)
srv.terminate(); srv.wait()
print('--- serve log ---'); print(open(out.name).read()[-2500:])
files = glob.glob(os.path.join(briefs, '**', '*.md'), recursive=True)
for f in files:
    print('BRIEF', f); print(open(f).read()[:1200])
summarize(port); mp.kill()
print('E2E', 'PASS' if files else 'FAIL')
