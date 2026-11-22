"""Container-level log of connects, listens and programs, written to /out/net.jsonl.

The namespace is shared with the plugin container, so /proc/net/tcp lists its sockets. When the plugin container also
shares this container's process namespace, /proc/<pid>/cmdline lists its programs. Both are sampled, so a connection
or program that lives for less than the sampling interval can be missed; the in-process hooks are the other record.
"""
import json
import os
import socket
import struct
import time

OUT = "/out/net.jsonl"
INTERVAL = 0.05
OWN = ("test -f /out/ready", "iptables", "ip6tables")


def address(hex_ip: str, hex_port: str) -> tuple[str, str]:
    port = str(int(hex_port, 16))
    raw = bytes.fromhex(hex_ip)
    if len(raw) == 4:
        return socket.inet_ntoa(raw[::-1]), port
    words = struct.unpack("<4I", raw)
    return socket.inet_ntop(socket.AF_INET6, struct.pack(">4I", *words)), port


def sockets(path: str):
    try:
        with open(path) as handle:
            next(handle)
            for line in handle:
                fields = line.split()
                yield address(*fields[1].split(":")), address(*fields[2].split(":")), fields[3]
    except (OSError, StopIteration):
        return


def command_of(pid: str) -> str:
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as handle:
            return handle.read().replace(b"\0", b" ").decode("utf-8", "replace").strip()
    except OSError:
        return ""


def parent_of(pid: str) -> str:
    try:
        with open(f"/proc/{pid}/stat") as handle:
            stat = handle.read()
        return stat[stat.rindex(")") + 2:].split()[1]
    except (OSError, ValueError, IndexError):
        return "0"


def runner_owned(pid: str, command: str) -> bool:
    """The bench's own scripts, the container runtime, and the browser the bench drives are not the plugin's."""
    if "/opt/bench/" in command or command.startswith("runc"):
        return True
    ancestor = parent_of(pid)
    for _ in range(12):
        if ancestor in ("0", "1", ""):
            return False
        if "/opt/bench/browse.mjs" in command_of(ancestor):
            return True
        ancestor = parent_of(ancestor)
    return False


def is_local(ip: str) -> bool:
    return ip.startswith("127.") or ip in ("::1", "0.0.0.0", "::") or ip.startswith("::ffff:127.")


def main() -> None:
    seen: set[str] = set()
    # What runs now is the helper's own (the proxy, this script's parent); only later processes are reported.
    initial = {entry for entry in os.listdir("/proc") if entry.isdigit()}
    known: dict[str, str] = {}
    with open(OUT, "a", buffering=1) as out:
        def emit(event: dict) -> None:
            key = json.dumps(event, sort_keys=True)
            if key not in seen:
                seen.add(key)
                out.write(json.dumps({**event, "ts": int(time.time() * 1000)}, sort_keys=True) + "\n")

        while True:
            rows = [row for table in ("/proc/net/tcp", "/proc/net/tcp6") for row in sockets(table)]
            listening = {local[1] for local, _remote, state in rows if state == "0A"}
            for local, remote, state in rows:
                if state == "0A":
                    emit({"t": "listen", "host": local[0], "port": local[1]})
                elif state in ("01", "02") and local[1] not in listening and not is_local(remote[0]):
                    # A socket on a listening port is an accepted one (the proxy's, or a plugin server's): inbound, not a connect.
                    emit({"t": "connect", "host": remote[0], "port": remote[1]})
            me = os.getpid()
            alive = [entry for entry in os.listdir("/proc") if entry.isdigit() and int(entry) != me]
            for entry in alive:
                command = command_of(entry)
                # A process shows its parent's command line until it executes its own program, so a change of command
                # line is a new program, not only a new process.
                if not command or known.get(entry) == command:
                    continue
                known[entry] = command
                if entry in initial or any(command.startswith(own) for own in OWN) or runner_owned(entry, command):
                    continue
                emit({"t": "exec", "cmd": command[:200]})
            for entry in set(known) - set(alive):
                del known[entry]
                initial.discard(entry)
            time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
