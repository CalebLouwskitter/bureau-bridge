import datetime
import os
from pathlib import Path
import subprocess
import time
from zoneinfo import ZoneInfo

zone = ZoneInfo(os.environ.get('TZ', 'Africa/Johannesburg'))
times = set(os.environ.get('BATCH_TIMES', '08:00,12:00,16:00,23:00').split(','))
state = Path(os.environ.get('EXCHANGE_ROOT', '/data/exchange')) / 'scheduled'
state.mkdir(parents=True, exist_ok=True)
while True:
    now = datetime.datetime.now(zone)
    key = now.strftime('%Y%m%d-%H%M')
    marker = state / key
    if now.strftime('%H:%M') in times and not marker.exists():
        result = subprocess.run(['php','/app/php/batch.php'])
        # One attempt per scheduled slot. Ambiguous results require inquiry.
        marker.write_text(str(result.returncode))
    time.sleep(10)
