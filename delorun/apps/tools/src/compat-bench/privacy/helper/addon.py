"""The proxy's addon: which canaries left, to which host, and which hosts could not be read.

Canary values arrive as JSON in BENCH_CANARIES ({"name": "value"}). A value is searched for as it is, percent-encoded,
as hexadecimal and in each of the three alignments of base64, in the URL, the headers and the body of every request,
in WebSocket messages and in raw TCP messages. The report is rewritten after every event, so it can be copied at any
time: /out/hosts.json holds {"hosts": [...]} and /out/net.jsonl (shared with poll.py) holds server connects with names.
"""
import base64
import json
import os
import urllib.parse

from mitmproxy import http, tcp, tls

OUT = "/out"
CANARIES = json.loads(os.environ.get("BENCH_CANARIES", "{}"))


def variants(value: str) -> list[bytes]:
    raw = value.encode()
    forms = {raw, urllib.parse.quote(value, safe="").encode(), raw.hex().encode()}
    for shift in range(3):
        encoded = base64.b64encode(b"x" * shift + raw)
        # Keep only whole groups made of value bytes: skip the first group when a prefix shares it, and drop the last.
        start = 4 if shift else 0
        forms.add(encoded[start:len(encoded) - 4])
    return [form for form in forms if len(form) >= 8]


PATTERNS = {name: variants(value) for name, value in CANARIES.items()}
HOSTS: dict[str, dict] = {}


def entry(host: str, port: int) -> dict:
    key = f"{host}:{port}"
    if key not in HOSTS:
        HOSTS[key] = {"host": host, "port": str(port), "canaries": [], "where": {}, "requests": 0, "pinned": False}
    return HOSTS[key]


def scan(found: dict, where: str, data: bytes) -> None:
    for name, forms in PATTERNS.items():
        if name not in found["where"] and any(form in data for form in forms):
            found["canaries"].append(name)
            found["where"][name] = where


def write() -> None:
    temporary = f"{OUT}/hosts.json.tmp"
    with open(temporary, "w") as handle:
        json.dump({"hosts": list(HOSTS.values())}, handle)
    os.replace(temporary, f"{OUT}/hosts.json")


def log_connect(host: str, port: int, name: str | None) -> None:
    event = {"t": "connect", "host": host, "port": str(port)}
    if name and name != host:
        event["name"] = name
    with open(f"{OUT}/net.jsonl", "a") as handle:
        handle.write(json.dumps(event, sort_keys=True) + "\n")


class Bench:
    def request(self, flow: http.HTTPFlow) -> None:
        found = entry(flow.request.pretty_host, flow.request.port)
        found["requests"] += 1
        scan(found, "url", flow.request.url.encode())
        scan(found, "header", b"\n".join(k + b": " + v for k, v in flow.request.headers.fields))
        scan(found, "body", flow.request.raw_content or b"")
        try:
            scan(found, "body", flow.request.get_content(strict=False) or b"")
        except ValueError:
            pass
        write()

    def websocket_message(self, flow: http.HTTPFlow) -> None:
        if flow.websocket and flow.websocket.messages:
            found = entry(flow.request.pretty_host, flow.request.port)
            found["requests"] += 1
            scan(found, "body", flow.websocket.messages[-1].content)
            write()

    def tcp_message(self, flow: tcp.TCPFlow) -> None:
        host, port = flow.server_conn.address or ("unknown", 0)
        found = entry(flow.server_conn.sni or host, port)
        found["requests"] += 1
        scan(found, "tcp", flow.messages[-1].content)
        write()

    def tls_failed_client(self, data: tls.TlsData) -> None:
        host, port = data.context.server.address or ("unknown", 0)
        entry(data.context.client.sni or host, port)["pinned"] = True
        write()

    def server_connect(self, data) -> None:
        if data.server.address:
            log_connect(data.server.address[0], data.server.address[1], data.server.sni)


addons = [Bench()]
