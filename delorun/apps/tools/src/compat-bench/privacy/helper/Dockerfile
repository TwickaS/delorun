# The bench's network helper (lane bench-privacy): owns a run's network namespace, runs a TLS-intercepting proxy in
# transparent mode with a throwaway CA made at start-up, and logs the connects, listens and (when the plugin container
# shares this container's process namespace) the programs it can see. Built by `bench image build --host helper`.
#
# The proxy image is pinned by digest (mitmproxy 12.1.2). To move the pin: pull the new tag, read its digest with
# `docker images --digests`, change the line below, and rebuild; `image.ts` hashes this file into the image tag.
FROM mitmproxy/mitmproxy@sha256:0d7b2a14b4a71a908cd6f31b8f50e29bbc5c8720fe6caa706acf782da558e5c7
LABEL delorun.bench="1" delorun.bench.role="helper"
RUN apt-get update \
 && apt-get install -y --no-install-recommends iptables \
 && rm -rf /var/lib/apt/lists/*
COPY addon.py poll.py entry.sh /bench/
RUN chmod 0755 /bench/entry.sh
# Root inside, but started with every capability dropped except NET_ADMIN (see image.ts): the rules below exempt uid 0,
# the proxy's own, from the redirect, and the plugin container's user is never uid 0.
ENTRYPOINT ["/bench/entry.sh"]
