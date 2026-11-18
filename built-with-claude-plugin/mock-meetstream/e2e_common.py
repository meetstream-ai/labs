"""Helpers for offline end-to-end checks against mock_meetstream.py."""
import json, os, socket, subprocess, sys, time, urllib.request

MOCK = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mock_meetstream.py')


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


def start_mock(log_path, env=None):
    port = free_port()
    p = subprocess.Popen([sys.executable, MOCK, '--port', str(port), '--log', log_path],
                         env=dict(os.environ, **(env or {})), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            urllib.request.urlopen('http://127.0.0.1:%d/__mock/log' % port, timeout=1); break
        except Exception:
            time.sleep(0.1)
    return p, port


def mock_call(port, method, path, body=None):
    r = urllib.request.Request('http://127.0.0.1:%d%s' % (port, path), method=method,
                               data=json.dumps(body).encode() if body is not None else None,
                               headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(r, timeout=30) as x:
        return json.loads(x.read())


def api_log(port):
    return [e for e in mock_call(port, 'GET', '/__mock/log') if 'method' in e]


def summarize(port):
    log = mock_call(port, 'GET', '/__mock/log')
    for e in log:
        if 'method' in e:
            print('  API', e['method'], e['path'], e.get('status'), 'UNKNOWN' if e.get('unknown') else '', e.get('auth_scheme'))
        elif 'outbound' in e:
            print('  OUT', e['outbound'], e.get('event'), e['status'], 'signed' if e['signed'] else '')
        else:
            print('  NOTE', {k: v for k, v in e.items() if k != 'at'})
    return log
