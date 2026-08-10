#!/usr/bin/env bash
#
# Postgres and Redis for the integration suite, without Docker or admin rights.
#
# CI runs those tests against real services; before this, a developer without
# Docker could only find a broken migration by pushing and waiting. The binaries
# are unpacked into ~/.local and the data directory is disposable.
set -euo pipefail

PG_VERSION="16.14.0"
REDIS_VERSION="7.2.5"
PG_HOME="${PG_HOME:-$HOME/.local/pg16}"
REDIS_HOME="${REDIS_HOME:-$HOME/.local/redis}"
PG_PORT="${PG_PORT:-55432}"
REDIS_PORT="${REDIS_PORT:-56379}"
PG_DATA="$PG_HOME/data"

arch() { [ "$(uname -m)" = "arm64" ] && echo "darwin-arm64v8" || echo "darwin-amd64"; }

install_postgres() {
  [ -x "$PG_HOME/bin/postgres" ] && return
  echo "==> Fetching PostgreSQL $PG_VERSION"
  local tmp; tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/pg.jar" \
    "https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-$(arch)/$PG_VERSION/embedded-postgres-binaries-$(arch)-$PG_VERSION.jar"
  (cd "$tmp" && unzip -oq pg.jar)
  mkdir -p "$PG_HOME"
  tar -xf "$tmp"/postgres-darwin-*.txz -C "$PG_HOME"
  rm -rf "$tmp"
}

install_redis() {
  [ -x "$REDIS_HOME/redis-server" ] && return
  echo "==> Building Redis $REDIS_VERSION"
  local tmp; tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/redis.tar.gz" "https://download.redis.io/releases/redis-$REDIS_VERSION.tar.gz"
  (cd "$tmp" && tar -xzf redis.tar.gz && cd "redis-$REDIS_VERSION" && make -j8 redis-server redis-cli >/dev/null 2>&1)
  mkdir -p "$REDIS_HOME"
  cp "$tmp/redis-$REDIS_VERSION/src/redis-server" "$tmp/redis-$REDIS_VERSION/src/redis-cli" "$REDIS_HOME/"
  rm -rf "$tmp"
}

start() {
  install_postgres
  install_redis

  if [ ! -d "$PG_DATA" ]; then
    "$PG_HOME/bin/initdb" -D "$PG_DATA" -U splite -A trust --no-locale -E UTF8 >/dev/null
  fi
  if ! "$PG_HOME/bin/pg_ctl" -D "$PG_DATA" status >/dev/null 2>&1; then
    "$PG_HOME/bin/pg_ctl" -D "$PG_DATA" \
      -o "-p $PG_PORT -c listen_addresses=127.0.0.1" -l "$PG_HOME/server.log" start >/dev/null
  fi

  "$REDIS_HOME/redis-cli" -p "$REDIS_PORT" ping >/dev/null 2>&1 || \
    "$REDIS_HOME/redis-server" --port "$REDIS_PORT" --daemonize yes --save '' --appendonly no

  # createdb is not shipped in these binaries, so the driver does it.
  DATABASE_URL="postgres://splite@127.0.0.1:$PG_PORT/postgres" node -e '
    const { Client } = require("pg");
    (async () => {
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      const { rowCount } = await c.query("SELECT 1 FROM pg_database WHERE datname = $1", ["splite_test"]);
      if (!rowCount) await c.query("CREATE DATABASE splite_test");
      await c.end();
    })();'

  DATABASE_URL="postgres://splite@127.0.0.1:$PG_PORT/splite_test" DB_SSL=false \
    LOG_LEVEL=silent node scripts/migrate.js

  echo "Postgres on $PG_PORT, Redis on $REDIS_PORT, migrations applied."
}

stop() {
  "$PG_HOME/bin/pg_ctl" -D "$PG_DATA" stop >/dev/null 2>&1 || true
  "$REDIS_HOME/redis-cli" -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
  echo "Stopped."
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 [start|stop]" >&2; exit 1 ;;
esac
