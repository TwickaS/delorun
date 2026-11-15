"""Decode screenshots from studio-browser output: reads stdin, writes <outdir>/<name>.jpg for each `name: [chunks]` entry."""
import re, sys, base64, os
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
name, chunks = None, []
def flush():
    if name and chunks:
        data = base64.b64decode(''.join(chunks))
        open(os.path.join(out, name + '.jpg'), 'wb').write(data)
        print(name, len(data))
for line in sys.stdin:
    m = re.match(r"\s*'?([\w-]+)'?: \[", line)
    if m:
        flush(); name, chunks = m.group(1), []
        continue
    chunks += re.findall(r"'([A-Za-z0-9+/=]{16,})'", line)
    if line.startswith('Console logs') or line.startswith('Page:'):
        flush(); name, chunks = None, []
        sys.stdout.write(line) if line.startswith('Page:') else None
flush()
