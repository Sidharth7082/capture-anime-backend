#!/usr/bin/env bash
# ============================================================================
# Starts the self-contained PostgreSQL 17 server (no root/systemd needed).
#
# The server was installed to ~/pg from the zonky embedded-postgres binaries
# (Debian/glibc build). It runs as the current user on 127.0.0.1:5432 with
# trust auth for local connections.
#
#   bash scripts/start-postgres.sh
# ============================================================================
set -euo pipefail

PG_HOME="${PG_HOME:-$HOME/pg}"
PG_BIN="$PG_HOME/pgdist/bin"
PG_DATA="$PG_HOME/data"
PG_LOG="$PG_HOME/postgres.log"
export LD_LIBRARY_PATH="$PG_HOME/pgdist/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

if "$PG_BIN/pg_ctl" -D "$PG_DATA" status >/dev/null 2>&1; then
  echo "PostgreSQL is already running:"
  "$PG_BIN/pg_ctl" -D "$PG_DATA" status
  exit 0
fi

"$PG_BIN/pg_ctl" -D "$PG_DATA" -l "$PG_LOG" -o "-p 5432 -k /tmp" start
echo "PostgreSQL started (log: $PG_LOG)"
