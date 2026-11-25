# shellcheck shell=bash
# Sourced by the release preparation scripts; defines functions only.

# Prints the `--user` value a builder container runs as: `0:0` on a rootless engine, whose container uid 0 is the
# caller's uid in the rootless namespace and so owns the mounted source, and the caller's own uid and gid on a rootful
# one. The test is the supervisor's: a rootless engine lists `name=rootless` among its `SecurityOptions`.
#
# Usage: builder_user
builder_user() {
  local security_options
  security_options="$(docker info --format '{{json .SecurityOptions}}')"
  case "$security_options" in
    *name=rootless*) printf '0:0\n' ;;
    *) printf '%s:%s\n' "$(id -u)" "$(id -g)" ;;
  esac
}
