#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for command in mariadbd mariadb-install-db mariadb mariadb-admin; do
  command -v "$command" >/dev/null || { echo "MariaDB is required: '$command' was not found." >&2; exit 1; }
done
mkdir -p .data
if [ ! -x .data/browser-runtime/usr/bin/Xvfb ] || [ ! -x .data/browser-runtime/usr/bin/x11vnc ] || [ ! -x .data/browser-runtime/usr/lib/firefox/firefox ] || [ ! -x .data/browser-runtime/usr/bin/xdotool ] || [ ! -x .data/browser-runtime/usr/bin/geckodriver ]; then
  echo "Setting up Firefox and VNC for Sources..."
  bash scripts/setup-browser.sh
fi
chmod 700 .data
socket="$PWD/.data/mariadb.sock"
if [ ! -d .data/mariadb/mysql ]; then
  mariadb-install-db --datadir="$PWD/.data/mariadb" --auth-root-authentication-method=normal --skip-test-db > .data/init.log 2>&1
fi
if mariadb-admin --socket="$socket" -u root ping >/dev/null 2>&1; then
  echo 'The project database is already running.' >&2
  exit 1
fi
db_pid=''
app_pid=''
start_database() {
  mariadbd --datadir="$PWD/.data/mariadb" --socket="$socket" --pid-file="$PWD/.data/mariadb.pid" --skip-networking >> .data/mariadb.log 2>&1 &
  db_pid=$!
}
cleanup() {
  if [ -n "$app_pid" ]; then kill "$app_pid" 2>/dev/null || true; wait "$app_pid" 2>/dev/null || true; fi
  if [ -n "$db_pid" ]; then kill "$db_pid" 2>/dev/null || true; wait "$db_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 0' INT TERM
start_database
for attempt in {1..50}; do
  if mariadb-admin --socket="$socket" -u root ping >/dev/null 2>&1; then break; fi
  if ! kill -0 "$db_pid" 2>/dev/null; then cat .data/mariadb.log >&2; exit 1; fi
  sleep 0.2
done
mariadb --socket="$socket" -u root -e 'CREATE DATABASE IF NOT EXISTS findmydeal CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
start_app() {
  DB_SOCKET="$socket" DB_USER=root DB_PASSWORD='' DB_NAME=findmydeal FMD_SUPERVISED=1 node server.js &
  app_pid=$!
}
start_app
# Keep the project-local database available if it exits unexpectedly.
failures=0
started_at=$SECONDS
while :; do
  exited_pid=''
  if wait -n -p exited_pid "$db_pid" "$app_pid"; then status=0; else status=$?; fi
  if [ "$exited_pid" = "$app_pid" ]; then
    app_pid=''
    if [ "$status" -eq 75 ]; then start_app; continue; fi
    exit "$status"
  fi
  if [ "$exited_pid" != "$db_pid" ]; then echo 'Could not monitor project processes.' >&2; exit 1; fi
  db_pid=''
  if (( SECONDS-started_at >= 60 )); then failures=0; fi
  failures=$((failures+1))
  if (( failures>3 )); then echo 'MariaDB repeatedly stopped; shutting down FindMyDeal. Check .data/mariadb.log.' >&2; exit 1; fi
  echo "MariaDB stopped (exit $status); restarting the project database." >&2
  sleep 2
  start_database
  started_at=$SECONDS
done
