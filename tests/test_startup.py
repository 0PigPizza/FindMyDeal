import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import unittest

ROOT=Path(__file__).resolve().parents[1]

class StartupTests(unittest.TestCase):
    def test_database_exit_is_restarted_without_stopping_app(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp);(base/'scripts').mkdir();shutil.copy(ROOT/'scripts/start.sh',base/'scripts/start.sh')
            for name in ('bin/Xvfb','bin/x11vnc','lib/firefox/firefox','bin/xdotool','bin/geckodriver'):
                f=base/'.data/browser-runtime/usr'/name;f.parent.mkdir(parents=True,exist_ok=True);f.write_text('#!/bin/sh\nexit 0\n');f.chmod(0o755)
            (base/'.data/mariadb/mysql').mkdir(parents=True)
            bindir=base/'bin';bindir.mkdir()
            programs={
              'mariadbd':'''#!/bin/bash
count=0; [ ! -f "$FMD_TEST_DIR/count" ] || read -r count < "$FMD_TEST_DIR/count"
count=$((count+1)); printf '%s' "$count" > "$FMD_TEST_DIR/count"
printf '%s' "$$" > "$FMD_TEST_DIR/database-pid"
if [ "$count" -eq 1 ]; then sleep 1; exit 3; fi
trap 'exit 0' TERM INT
while :; do sleep 1; done
''',
              'mariadb-admin':'''#!/bin/bash
[ -f "$FMD_TEST_DIR/database-pid" ] || exit 1
read -r p < "$FMD_TEST_DIR/database-pid" || [ -n "$p" ]
kill -0 "$p" 2>/dev/null
''',
              'mariadb-install-db':'#!/bin/sh\nexit 0\n',
              'mariadb':'#!/bin/sh\nexit 0\n',
              'node':'''#!/bin/bash
printf '%s' "$$" > "$FMD_TEST_DIR/app-pid"
trap 'exit 0' TERM INT
while :; do sleep 1; done
'''}
            for name,script in programs.items():
                f=bindir/name;f.write_text(script);f.chmod(0o755)
            env={**os.environ,'PATH':str(bindir)+':'+os.environ['PATH'],'FMD_TEST_DIR':str(base)}
            process=subprocess.Popen(['bash',str(base/'scripts/start.sh')],cwd=base,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
            try:
                deadline=time.monotonic()+12
                while time.monotonic()<deadline:
                    if process.poll() is not None:self.fail('startup exited before database recovered: '+process.stderr.read())
                    if (base/'count').exists() and (base/'count').read_text()=='2' and (base/'app-pid').exists():break
                    time.sleep(.1)
                else:self.fail('database was not restarted')
                app_pid=int((base/'app-pid').read_text());os.kill(app_pid,0)
                self.assertIsNone(process.poll())
            finally:
                os.killpg(process.pid,signal.SIGTERM)
                process.communicate(timeout=5)

if __name__=='__main__':unittest.main()
