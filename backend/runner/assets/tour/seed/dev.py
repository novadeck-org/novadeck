"""The game's dev server: python3 dev.py [port]

It serves this folder, with the work of every git worktree of this repo laid over it: a file
that a worktree changed (or added) since it parted from this folder is served from that
worktree, the newest change first. So the page shows everyone's work at once, before any of it
is merged. The page reloads by itself when a file changes. (dev.mjs is the same server for
Node.)
"""

import os
import re
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socketserver import TCPServer
from urllib.parse import unquote, urlsplit

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5180
HOME = os.getcwd()
TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".gltf": "model/gltf+json",
    ".bin": "application/octet-stream",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
}
SKIPPED = {".git", "vendor", "node_modules"}
HOSTS = {"127.0.0.1:" + str(PORT), "localhost:" + str(PORT)}
RELOAD = b"""<script>
  // Added by dev.py: reload when a file changes.
  let seen
  setInterval(async () => {
    const now = await fetch("/__version").then((answer) => answer.text(), () => seen)
    if (seen !== undefined && now !== seen) location.reload()
    seen = now
  }, 700)
</script>"""


# Git only reads here, and never takes the index's lock to refresh it (`--no-optional-locks`), so
# a commit Novadeck makes in these folders meanwhile never finds the lock held.
GIT = ["git", "--no-optional-locks"]


def worktrees():
    """The other worktrees of this repo, as git lists them; none without git."""
    try:
        listed = subprocess.run(
            [*GIT, "worktree", "list", "--porcelain"], cwd=HOME, capture_output=True, text=True
        ).stdout
    except OSError:
        return []
    folders = [line[9:] for line in listed.splitlines() if line.startswith("worktree ")]
    return [f for f in map(os.path.normpath, folders) if f != os.path.normpath(HOME) and os.path.isdir(f)]


def read(file):
    try:
        with open(file, "rb") as opened:
            return opened.read()
    except OSError:
        return None


def changed_at(file):
    """When a file last changed; 0 for one that is gone meanwhile."""
    try:
        return os.path.getmtime(file)
    except OSError:
        return 0.0


def parts_of(route):
    """The path a request names, inside the project: its parts, with none that leaves the
    folder or names a hidden file (.git and the like), a drive or a device. None for any other."""
    parts = [part for part in re.split(r"[/\\]+", route) if part]
    for part in parts:
        if part.startswith(".") or ":" in part or "\0" in part:
            return None
    return parts or ["index.html"]


def git(folder, *args):
    """Runs git in a folder: what it prints, or None where it fails (no git, no repo, no commit)."""
    try:
        ran = subprocess.run([*GIT, *args], cwd=folder, capture_output=True)
    except OSError:
        return None
    return ran.stdout.decode("utf-8", "surrogateescape") if ran.returncode == 0 else None


def changed_since(folder, base):
    """The files a folder changed since `base`: those that differ from that commit, and those
    git doesn't track, ignored ones too (what a build wrote is that folder's own). As git names
    them, from the top of the project, with "/" between parts. Not vendor/, which `pick` serves
    from this folder alone."""
    printed = (git(folder, "diff", "--name-only", "-z", base) or "") + (
        git(folder, "ls-files", "--others", "-z", "--", ".", ":(exclude)vendor") or ""
    )
    return {name for name in printed.split("\0") if name}


def changes():
    """What each worktree changed since it parted from this folder (`theirs`), and what this
    folder changed since then (`ours`). They parted at the last commit both have; where they
    share none, a worktree's changes are those since its own last commit. A worktree's file
    that nobody touched there is not its work, however far this folder has moved on since."""
    head = (git(HOME, "rev-parse", "HEAD") or "").strip()
    # This folder's changes are asked once for each commit worktrees parted at, often one.
    ours = {}
    listed = []
    for folder in others(True):
        base = (head and (git(folder, "merge-base", "HEAD", head) or "").strip()) or "HEAD"
        if base not in ours:
            ours[base] = changed_since(HOME, base)
        listed.append((folder, changed_since(folder, base), ours[base]))
    return listed


LISTED = {}


def others(fresh=False):
    """The other worktrees as git last listed them: asked again when `fresh`, and after two
    seconds. Every request needs them, and git is slow to start on some computers."""
    if fresh or "at" not in LISTED or time.monotonic() - LISTED["at"] > 2:
        LISTED.update(at=time.monotonic(), folders=worktrees())
    return LISTED["folders"]


KEPT = {}
READING = threading.Lock()


def current():
    """The changes as of now: read again when a file changed anywhere, and every two seconds
    for what changes no file (a commit, a merge)."""
    # One request at a time: those that arrive together after a change read it once.
    with READING:
        now = version()
        if KEPT.get("version") != now or time.monotonic() - KEPT.get("at", 0.0) > 2:
            KEPT.update(version=now, at=time.monotonic(), listed=changes())
        return KEPT["listed"]


def pick(path):
    """The file to serve for a path: the copy of a worktree that changed it (the newest such
    copy, this folder's own among them where it changed the file too), else this folder's own."""
    own = os.path.join(HOME, path)
    has = os.path.isfile(own)
    if path.split(os.sep)[0] == "vendor":
        return own if has else None
    name = "/".join(path.split(os.sep))
    changed = [each for each in current() if name in each[1]]
    copies = [os.path.join(folder, path) for folder, _, _ in changed]
    copies = [file for file in copies if os.path.isfile(file)]
    if has and (not copies or any(name in ours for _, _, ours in changed)):
        copies.append(own)
    copies.sort(key=changed_at, reverse=True)
    return copies[0] if copies else None


def version(fresh=False):
    """When anything the page could show last changed, in any worktree."""
    latest = 0.0
    for root in [HOME, *others(fresh)]:
        for folder, folders, files in os.walk(root):
            folders[:] = [n for n in folders if n not in SKIPPED and not n.startswith(".")]
            for name in files:
                if not name.startswith("."):
                    latest = max(latest, changed_at(os.path.join(folder, name)))
    return str(latest)


class Handler(BaseHTTPRequestHandler):
    def send(self, status, kind, body):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            self.answer()
        except Exception as error:  # A file that went away meanwhile, say: the server stays.
            self.send(500, "text/plain", ("The dev server couldn't answer that: " + str(error)).encode())

    def answer(self):
        # Only this computer's own pages may ask: a request under another host name is some
        # other site's page reaching for this server, and is refused.
        if self.headers.get("Host") not in HOSTS:
            return self.send(403, "text/plain", b"No.")
        try:
            route = unquote(urlsplit(self.path).path, errors="strict")
        except ValueError:
            return self.send(404, "text/plain", b"Not found.")
        if route == "/__version":
            return self.send(200, "text/plain", version(True).encode())
        parts = parts_of(route)
        if parts is None:
            return self.send(404, "text/plain", b"Not found.")
        file = pick(os.path.join(*parts))
        if file is None:
            return self.send(404, "text/plain", ("Not found: " + "/".join(parts)).encode())
        kind = TYPES.get(os.path.splitext(file)[1], "application/octet-stream")
        body = read(file)
        if body is None:
            return self.send(404, "text/plain", ("Not found: " + "/".join(parts)).encode())
        if kind.startswith("text/html"):
            body = body.replace(b"</body>", RELOAD + b"</body>")
        self.send(200, kind, body)
        print("GET", route, "" if file.startswith(HOME) else "  <- " + file, flush=True)

    def log_message(self, *args):
        pass


class Server(ThreadingHTTPServer):
    def server_bind(self):
        # Python's own asks the system for this computer's name between taking the port and
        # listening on it, which can take seconds; a page asking meanwhile would wait or fail.
        TCPServer.server_bind(self)
        self.server_name, self.server_port = "127.0.0.1", PORT


# Said once it listens, so whoever reads this line can ask at once.
server = Server(("127.0.0.1", PORT), Handler)
print(f"The game is at http://127.0.0.1:{PORT}/", flush=True)
server.serve_forever()
