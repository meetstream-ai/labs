import os, sys, threading, time, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'mock-meetstream'))
from e2e_common import *
APP = os.path.dirname(os.path.abspath(__file__))
mp, port = start_mock(tempfile.mktemp(suffix='.jsonl'))
os.environ.update(MEETSTREAM_API_KEY='test-key', MEETSTREAM_BASE_URL='http://127.0.0.1:%d/api/v1' % port)
sys.path.insert(0, APP)
import meetstream_app as m
from werkzeug.serving import make_server
wp = free_port(); srv = make_server('127.0.0.1', wp, m.app); threading.Thread(target=srv.serve_forever, daemon=True).start()
ok = False
try:
    bot_id = m.send_bot('https://meet.google.com/abc-defg-hij', webhook_url='http://127.0.0.1:%d/webhooks/meetstream' % wp)
    print('bot', bot_id)
    mock_call(port, 'POST', '/__mock/simulate/' + bot_id)
    time.sleep(0.5)
    print('SAVED', m.SAVED)
    ok = bool(m.SAVED.get(bot_id))
finally:
    summarize(port); srv.shutdown(); mp.kill()
print('E2E', 'PASS' if ok else 'FAIL')
