#!/bin/bash
# Live Delorun studio for security calibration: a scratch home on 127.0.0.1:18840 and the client watchers that feed its bundles.
# Usage: calib-preview.sh [start|stop|link]. Run from any directory; the worktree is the one holding this script.
# The DeepSeek key is read from ~/.config/delorun/inference.env at run time and is never written to a file.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
HOME_DIR="${CALIB_HOME:-/tmp/calib-home}"
PORT=18840
source ~/.nvm/nvm.sh >/dev/null
cd "$ROOT" && nvm use >/dev/null
export DELORUN_HOME="$HOME_DIR"
cli() { nice -n 19 node_modules/.bin/tsx delorun/apps/cli/src/bin.ts "$@"; }
case "${1:-start}" in
  stop)
    cli stop || true
    [ -f "$HOME_DIR/watch.pid" ] && kill -INT "$(cat "$HOME_DIR/watch.pid")" 2>/dev/null || true
    ;;
  link)
    cli open --print
    ;;
  start)
    set -a; . ~/.config/delorun/inference.env; set +a
    if [ ! -d "$HOME_DIR/profiles/default" ]; then
      mkdir -p -m 700 "$HOME_DIR"
      cli setup --yes --provider deepseek-official --key-env DEEPSEEK_API_KEY --no-update-check
      cat >> "$HOME_DIR/profiles/default/cordis.patch.yml" <<YAML
- id: webserver
  config:
    host: 127.0.0.1
    port: $PORT
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
YAML
    fi
    [ -d apps/web/dist ] || nice -n 19 pnpm run build:artifacts
    [ -f delorun/packages/bundle-local/lib/index.js ] || nice -n 19 pnpm --no-sort --workspace-concurrency=2 --filter "./delorun/packages/**" run build
    nice -n 19 node_modules/.bin/tsx scripts/dev-web.ts --poll --skip-build --no-serve >"$HOME_DIR/watch.log" 2>&1 &
    echo $! >"$HOME_DIR/watch.pid"
    trap 'kill -INT "$(cat "$HOME_DIR/watch.pid")" 2>/dev/null || true' EXIT
    cli start --foreground
    ;;
esac
