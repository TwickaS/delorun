"""Spike test server for WP1.18: an HTTP/1.1 server on a mode-0600 Unix socket.

Usage: python3 -I socket-server.py <socket path>
       python3 -I socket-server.py tcp   (the C7 fallback target: 127.0.0.1, a port the OS assigns)

Creates the socket with umask 0177 so it is mode 0600 from bind(2) on, sets the
mode again after bind, and answers every request with a fixed text body. Each
request is logged to stdout as one JSON line with the peer's SO_PEERCRED
(pid, uid, gid), the peer's /proc comm, the request line and every request
header whose name starts with "tailscale-" (any case), plus Host and
X-Forwarded-*. Linux only (SO_PEERCRED). It enforces no peer-credential check:
the spike measures who can connect, not a policy.
"""

import json
import os
import socket
import socketserver
import struct
import sys
from http.server import BaseHTTPRequestHandler


def peer_credentials(sock):
    if sock.family != socket.AF_UNIX:
        return {"tcp": "%s:%d" % sock.getpeername()[:2]}
    raw = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    pid, uid, gid = struct.unpack("3i", raw)
    try:
        with open(f"/proc/{pid}/comm", encoding="utf-8") as comm:
            name = comm.read().strip()
    except OSError as error:  # the peer may live in another PID namespace (container) or have exited
        name = f"<unreadable: {error.strerror}>"
    return {"pid": pid, "uid": uid, "gid": gid, "comm": name}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        logged = {
            name: value
            for name, value in self.headers.items()
            if name.lower().startswith("tailscale-") or name.lower() in ("host",) or name.lower().startswith("x-forwarded-")
        }
        print(json.dumps({"peer": peer_credentials(self.request), "request": self.requestline, "headers": logged}), flush=True)
        body = b"serve-socket spike: ok\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


def main():
    path = sys.argv[1]
    if path == "tcp":
        server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
        print(json.dumps({"listening": "127.0.0.1:%d" % server.server_address[1]}), flush=True)
        server.serve_forever()
        return
    os.umask(0o177)
    server = socketserver.ThreadingUnixStreamServer(path, Handler)
    os.chmod(path, 0o600)
    print(json.dumps({"listening": path, "mode": oct(os.stat(path).st_mode & 0o777)}), flush=True)
    try:
        server.serve_forever()
    finally:
        os.unlink(path)


if __name__ == "__main__":
    main()
