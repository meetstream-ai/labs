"""E2E: talk-time --bot-id against the mock, inline timeline and the speaker_timeline_url form."""
import json, os, subprocess, sys, tempfile, urllib.request
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'mock-meetstream'))
from e2e_common import *
APP = os.path.abspath(os.path.dirname(os.path.abspath(__file__)))
PY = os.path.join(APP, '.venv', 'bin', 'python')
results = {}
for form in ('inline', 'url'):
    tls = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tls')
    if form == 'url' and not os.path.exists(os.path.join(tls, 'cert.pem')):
        os.makedirs(tls, exist_ok=True)
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', os.path.join(tls, 'key.pem'),
                        '-out', os.path.join(tls, 'cert.pem'), '-days', '30', '-subj', '/CN=127.0.0.1',
                        '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE'], capture_output=True)
    menv = {'MOCK_TIMELINE_URL_FORM': '1', 'MOCK_MEDIA_TLS': os.path.join(tls, 'cert.pem') + ':' + os.path.join(tls, 'key.pem')} if form == 'url' else {}
    mp, port = start_mock(tempfile.mktemp(suffix='.jsonl'), menv)
    req = urllib.request.Request('http://127.0.0.1:%d/api/v1/bots/create_bot' % port, data=json.dumps({'meeting_link': 'https://meet.google.com/abc-defg-hij'}).encode(),
                                 headers={'Authorization': 'Token t', 'Content-Type': 'application/json'})
    bot = json.loads(urllib.request.urlopen(req).read())['bot_id']
    mock_call(port, 'POST', '/__mock/simulate/' + bot)
    out = tempfile.mktemp(suffix='.json')
    env = dict(os.environ, MEETSTREAM_API_KEY='test-key', MEETSTREAM_BASE_URL='http://127.0.0.1:%d/api/v1' % port)
    if form == 'url':
        env['SSL_CERT_FILE'] = os.path.join(tls, 'cert.pem')  # trust the mock's self-signed media cert
    r = subprocess.run([PY, '-m', 'talk_time.cli', '--bot-id', bot, '--json-out', out], cwd=tempfile.gettempdir(), env=env, capture_output=True, text=True)
    print('[%s] rc=%d' % (form, r.returncode)); print((r.stdout + r.stderr)[-1200:])
    summarize(port); mp.kill()
    rep = json.load(open(out)) if os.path.exists(out) else {}
    txt = json.dumps(rep)
    # expected: Ana 3.2+2.3=5.5 s, Ben 4.3+1.4=5.7 s
    results[form] = r.returncode == 0 and 'Ana' in txt and 'Ben' in txt
print('E2E inline', 'PASS' if results['inline'] else 'FAIL', '| url form', 'PASS' if results['url'] else 'FAIL')
print('E2E', 'PASS' if all(results.values()) else 'FAIL')
