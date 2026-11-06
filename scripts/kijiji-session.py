#!/usr/bin/env python3
"""Check Kijiji login cookie names in a temporary, private profile snapshot."""
import os
import pathlib
import shutil
import sqlite3
import sys
import tempfile
import time

profile = pathlib.Path(sys.argv[1])
try:
    with tempfile.TemporaryDirectory(prefix='findmydeal-', dir='/dev/shm' if os.path.isdir('/dev/shm') else None) as temp:
        for name in ('cookies.sqlite', 'cookies.sqlite-wal', 'cookies.sqlite-shm'):
            source = profile / name
            if source.exists():
                shutil.copyfile(source, pathlib.Path(temp) / name)
        db = sqlite3.connect(f'file:{temp}/cookies.sqlite?mode=ro', uri=True, timeout=1)
        rows = db.execute("SELECT name FROM moz_cookies WHERE (host = 'kijiji.ca' OR host LIKE '%.kijiji.ca') AND name IN ('kj-at', 'kj-rt') AND expiry > ?", (int(time.time()),)).fetchall()
        print('yes' if {row[0] for row in rows} == {'kj-at', 'kj-rt'} else 'no')
except (OSError, sqlite3.Error):
    print('unknown')
