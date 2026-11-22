#!/bin/sh
# Helper entry: start the proxy (which makes the CA), wait for the CA, redirect the plugin container's outgoing TCP to
# the proxy, start the socket poll, and say ready by creating /out/ready. Stops cleanly on TERM so the proxy writes its
# report.
set -eu
mkdir -p /out /ca
mitmdump --mode transparent --listen-host 0.0.0.0 --listen-port 8080 --set confdir=/ca --set termlog_verbosity=warn ${BENCH_PROXY_ARGS:-} \
  --set flow_detail=0 -s /bench/addon.py >/out/proxy.log 2>&1 &
PROXY=$!
n=0
while [ ! -s /ca/mitmproxy-ca-cert.pem ]; do
  n=$((n + 1))
  if [ "$n" -gt 200 ] || ! kill -0 "$PROXY" 2>/dev/null; then echo "proxy did not start" >&2; cat /out/proxy.log >&2; exit 1; fi
  sleep 0.1
done
cp /ca/mitmproxy-ca-cert.pem /out/ca.pem
# The proxy and this script run as uid 0 and are never redirected; the plugin container's user is not uid 0.
# Loopback traffic and traffic to this namespace's own addresses stay local: the studio and the mock model live there.
command -v iptables >/dev/null 2>&1 || { echo "iptables is missing from the helper image" >&2; exit 1; }
for tool in iptables ip6tables; do
  command -v "$tool" >/dev/null 2>&1 || continue
  # A missing IPv6 table is fine (the namespace may have no IPv6); a missing IPv4 rule is not.
  if [ "$tool" = ip6tables ]; then set +e; fi
  "$tool" -t nat -A OUTPUT -o lo -j RETURN \
    && "$tool" -t nat -A OUTPUT -m owner --uid-owner 0 -j RETURN \
    && "$tool" -t nat -A OUTPUT -m addrtype --dst-type LOCAL -j RETURN \
    && "$tool" -t nat -A OUTPUT -p tcp -j REDIRECT --to-ports 8080 \
    || { [ "$tool" = ip6tables ] || { echo "$tool rules failed" >&2; exit 1; }; }
  set -e
done
python3 /bench/poll.py >/out/poll.log 2>&1 &
POLL=$!
trap 'kill -TERM "$PROXY" "$POLL" 2>/dev/null || true; wait "$PROXY" 2>/dev/null || true; exit 0' TERM INT
touch /out/ready
wait "$PROXY"
