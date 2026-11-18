"""E2E for voice-managed / voice-byok: POST /mia then create_bot with agent_config_id.
voice-managed runs with MOCK_NO_BYOK=1 (the user has no provider keys), voice-byok with keys saved."""
import os, subprocess, sys, tempfile, json
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'mock-meetstream'))
from e2e_common import *
app = 'voice-byok'
APP = os.path.abspath(os.path.dirname(os.path.abspath(__file__)))
PY = os.path.join(APP, '.venv', 'bin', 'python') if os.path.exists(os.path.join(APP, '.venv')) else 'python3'
mp, port = start_mock(tempfile.mktemp(suffix='.jsonl'), {'MOCK_NO_BYOK': '1'} if app == 'voice-managed' else {})
envfile = tempfile.mktemp(suffix='.env')
src = open(os.path.join(APP, '.env.example')).read()
lines = [l for l in src.splitlines() if l.strip() and not l.startswith('#') and not l.startswith('MEETSTREAM_BASE_URL') and not l.startswith('MEETSTREAM_API_KEY')]
open(envfile, 'w').write('\n'.join(lines + ['MEETSTREAM_API_KEY=test-key', 'MEETSTREAM_BASE_URL=http://127.0.0.1:%d/api/v1' % port]) + '\n')
mod = 'voice_agent.main' if app == 'voice-managed' else 'voice_agent'
args = [PY, '-m', mod, '--env-file', envfile]
r = subprocess.run(args + (['--yes'] if '--yes' in subprocess.run(args + ['--help'], cwd=APP, capture_output=True, text=True).stdout else []),
                   cwd=APP, capture_output=True, text=True, input='y\n', env=dict(os.environ, PYTHONWARNINGS='ignore'))
print('rc', r.returncode); print((r.stdout + r.stderr)[-1500:])
log = summarize(port)
mia = [e for e in log if e.get('path') == '/api/v1/mia' and e.get('method') == 'POST']
for e in mia:
    print('MIA BODY', json.dumps(e['body'])[:900])
created = [e for e in log if e.get('path') == '/api/v1/bots/create_bot' and e.get('status') == 201 and e['body'].get('agent_config_id')]
mp.kill()
print('E2E', 'PASS' if mia and mia[0]['status'] == 200 and created else 'FAIL')
