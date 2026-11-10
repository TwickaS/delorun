---
section: Security
---

- The local sandbox can now keep confined commands from reading or writing a protected folder, such as Delo's home, and from connecting to listed sockets, such as Docker's. A writable workspace that contains the protected folder is refused for commands, and the file tools refuse to read, search or write inside that folder. The sandbox also records which of these rules each platform cannot enforce: Landlock cannot block socket connections, and Windows does not limit reads.
