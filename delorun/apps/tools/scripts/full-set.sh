#!/usr/bin/env bash
# Team tooling: the integration lane's full set on the trunk worktree.
# Run from the worktree root after `build:artifacts` (the build slot is the caller's).
# Logs go to $1 (default: $TMPDIR/full-set-logs); each step prints PASS or FAIL.
set -u
source ~/.nvm/nvm.sh >/dev/null && nvm use >/dev/null
logs="${1:-${TMPDIR:-/tmp}/full-set-logs}"
mkdir -p "$logs"
fail=0
step() {
  local name="$1"; shift
  if nice -n 10 "$@" >"$logs/$name.log" 2>&1; then echo "PASS $name"; else echo "FAIL $name ($logs/$name.log)"; fail=1; fi
}
step tsc-browser-use-runtime pnpm exec tsc -b packages/experimental/browser-use-runtime
step tsc-playwright-mcp pnpm exec tsc -b packages/experimental/browser-use-playwright-mcp
step tsc-mcp-client pnpm exec tsc -b packages/mcp/mcp-client
step output-folder-e2e pnpm exec vitest run --config vitest.e2e.config.ts --maxWorkers=2 packages/sandbox/sandbox-local/tests/output-folder.e2e.ts
step hygiene pnpm run hygiene
exit "$fail"
