import argparse
import http.server
import json
import os
import pathlib
import pty
import re
import select
import shlex
import shutil
import socket
import subprocess
import tempfile
import termios
import threading
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--evidence", default=os.environ.get("EVIDENCE_DIR"))
args = parser.parse_args()
work = pathlib.Path(tempfile.mkdtemp(prefix="annotation-direct-", dir=args.evidence)).resolve()
here = pathlib.Path(__file__).resolve().parent
root = here.parent.parent
home = work / "home"
agent = home / ".pi" / "agent"
project = work / "project"
agent.mkdir(parents=True)
project.mkdir()
registry = agent / "annotation" / "sessions"
registry.mkdir(parents=True)
pi = pathlib.Path(os.environ.get("PI_BIN") or pathlib.Path(shutil.which("pi")).parent) / "pi"
env = dict(PATH=os.environ["PATH"], HOME=str(home), PI_CODING_AGENT_DIR=str(agent), TERM="xterm-256color", LANG="en_US.UTF-8", SHELL="/bin/sh")
socket_dir = pathlib.Path(tempfile.mkdtemp(prefix="annotation-tmux-"))
socket_path = str(socket_dir / "socket")
children = []
terminals = []
checks = []


def check(name, actual, expected):
    assert actual == expected, f"{name}: {actual!r} != {expected!r}"
    checks.append(name)
    print("PASS " + name, flush=True)


def wait(predicate, label, timeout=25):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError("timeout: " + label)


def user_text(content):
    return "".join(part["text"] for part in content) if isinstance(content, list) else content


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def tmux(*argv):
    return subprocess.check_output(["tmux", "-f", "/dev/null", "-S", socket_path, *argv], text=True, env=env)


def capture():
    value = tmux("capture-pane", "-p", "-J", "-t", "pi", "-S", "-200")
    (work / "pi-screen.txt").write_text(value)
    return value


def pi_text(text):
    tmux("send-keys", "-t", "pi", "-l", text)


def command(text):
    pi_text(text)
    tmux("send-keys", "-t", "pi", "Enter")


def editor():
    try:
        return json.loads((work / "editor.json").read_text())["editor"]
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def set_editor(text):
    if editor():
        tmux("send-keys", "-t", "pi", "C-c")
        wait(lambda: editor() == "", "clear editor")
    command("/probe-set-editor " + json.dumps(text))
    wait(lambda: editor() == text, "set editor")


class Terminal:
    def __init__(self, name, argv, cwd=project):
        self.name = name
        self.master, self.slave = pty.openpty()
        termios.tcsetwinsize(self.slave, (36, 140))
        self.before = termios.tcgetattr(self.slave)
        self.data = b""
        self.process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=self.slave, stdout=self.slave, stderr=self.slave)
        terminals.append(self)

    def screen(self):
        while select.select([self.master], [], [], 0)[0]:
            self.data += os.read(self.master, 65536)
        (work / (self.name + ".ansi")).write_bytes(self.data)
        return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]", "", self.data.decode(errors="replace"))

    def send(self, text):
        os.write(self.master, text.encode())

    def sees(self, text):
        wait(lambda: text in self.screen(), self.name + " displays " + text)

    def finish(self, code=0):
        wait(lambda: (self.screen(), self.process.poll() is not None)[1], self.name + " exits")
        self.screen()
        check(self.name + " exit", self.process.returncode, code)
        check(self.name + " restores terminal modes", termios.tcgetattr(self.slave), self.before)

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                wait(lambda: (self.screen(), self.process.poll() is not None)[1], self.name + " cleanup", 10)
            except AssertionError:
                self.process.kill()
                self.process.wait()
        self.screen()
        os.close(self.master)
        os.close(self.slave)


def cli(name, *argv, cwd=project):
    return Terminal(name, ["node", str(root / "bin" / "pi-annotation.ts"), *argv], cwd)


def note(terminal, text):
    terminal.send("a")
    terminal.sees(" NOTE ")
    terminal.send(text + "\r")
    terminal.sees("added note 1;")


fixture_requests = []


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        fixture_requests.append(self.path)
        data = {"version": 1, "nextSeq": 1, "items": [{"id": "a", "kind": "assistant", "label": "Assistant", "text": "fixture " + self.path.split("/")[1]}]}
        if "/events" in self.path:
            threading.Event().wait(0.1)
            data = {"version": 1, "reset": False, "items": []}
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def log_message(self, *args):
        pass


print("Evidence: " + str(work), flush=True)
try:
    port = free_port()
    fake = subprocess.Popen(["node", str(here / "fake-openai.mjs"), str(port)], stdout=(work / "fake.log").open("w"), stderr=subprocess.STDOUT)
    children.append(fake)

    def fake_get(endpoint):
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/{endpoint}", timeout=3) as response:
            return json.loads(response.read())

    def ready():
        try:
            return fake_get("count") == 0
        except OSError:
            return False

    wait(ready, "fake provider ready")
    (agent / "models.json").write_text(json.dumps({"providers": {"fake": {"baseUrl": f"http://127.0.0.1:{port}/v1", "api": "openai-completions", "apiKey": "fake", "models": [{"id": "fake-model", "name": "Fake model"}]}}}))
    runtime_env = dict(env, PI_ANNOTATE_PORT=str(free_port()), ANNOTATE_EDITOR_PROBE=str(work / "editor.json"))
    runtime = ["env", "-i", *[f"{k}={v}" for k, v in runtime_env.items()], str(pi), "--tui-mode", "fullscreen", "--provider", "fake", "--model", "fake-model", "--extension", str(root / "index.ts"), "--extension", str(here / "editor-probe.ts")]
    tmux("new-session", "-d", "-s", "pi", "-x", "140", "-y", "45", "-c", str(project), shlex.join(runtime))
    wait(lambda: editor() is not None, "pi startup", 60)
    command("explain the cache")
    wait(lambda: "It evicts the oldest entry first." in capture(), "initial model response")
    command("/annotate")
    entry_file = wait(lambda: next(iter(registry.glob("*.json")), None), "registry entry")
    entry = json.loads(entry_file.read_text())
    set_editor("SENTINEL_DRAFT")
    client = cli("lowercase", entry["sessionId"])
    client.sees("The cache is LRU.")
    count = fake_get("count")
    note(client, "editor note")
    client.send("s")
    client.sees("sent 1 to the pi editor")
    wait(lambda: editor() == "SENTINEL_DRAFT\n> The cache is LRU.\n\neditor note\n\n", "lowercase editor append")
    check("s appends exact annotation without a model turn", fake_get("count"), count)
    client.send("q")
    client.finish()
    set_editor("SENTINEL_DRAFT")
    client = cli("uppercase", entry["sessionId"])
    client.sees("The cache is LRU.")
    note(client, "direct note")
    client.send("S")
    client.sees("submitted 1 to pi")
    wait(lambda: fake_get("count") >= count + 2, "direct model turn")
    check("S sends exact annotation text", user_text(fake_get("last-user")), "> The cache is LRU.\n\ndirect note\n\n")
    check("S preserves editor draft", editor(), "SENTINEL_DRAFT")
    client.send("q")
    client.finish()
    wait(lambda: "It evicts the oldest entry first." in capture(), "direct response completes")
    set_editor("")
    command("ANNOTATION_HOLD")
    wait(lambda: fake_get("held"), "busy model response held")
    wait(lambda: "Holding current work." in capture(), "busy response displayed")
    command('/probe-set-editor "BUSY_SENTINEL"')
    wait(lambda: editor() == "BUSY_SENTINEL", "busy editor sentinel")
    held_count = fake_get("count")
    client = cli("busy", entry["sessionId"])
    client.sees("pi-annotation")
    client.send("gg")
    client.sees("explain the cache")
    note(client, "busy note")
    client.send("S")
    client.sees("submitted 1 to pi")
    wait(lambda: "Follow-up: > explain the cache" in capture(), "pi displays queued follow-up")
    check("busy S does not start another request before release", fake_get("count"), held_count)
    check("busy S preserves editor draft", editor(), "BUSY_SENTINEL")
    check("held response released", fake_get("release"), True)
    wait(lambda: fake_get("count") >= held_count + 3, "tool continuation and annotation turn")
    events = fake_get("events")
    (work / "model-events.json").write_text(json.dumps(events, indent=2))
    following = [e for e in events if e["kind"] == "request" and e["requestId"] > held_count]
    check("current tool turn runs before follow-up", [(e["lastRole"], user_text(json.loads(e["lastUser"]))) for e in following[:2]], [("tool", "ANNOTATION_HOLD"), ("user", "> explain the cache\n\nbusy note\n\n")])
    complete_index = next(i for i, e in enumerate(events) if e == {"kind": "complete", "requestId": held_count + 1})
    follow_index = next(i for i, e in enumerate(events) if e["kind"] == "request" and e["requestId"] == held_count + 2)
    check("current response completes before annotation request", complete_index < follow_index, True)
    check("busy annotation exact text", user_text(fake_get("last-user")), "> explain the cache\n\nbusy note\n\n")
    check("busy draft survives follow-up execution", editor(), "BUSY_SENTINEL")
    client.send("q")
    client.finish()
    tmux("kill-session", "-t", "pi")
    entry_file.unlink(missing_ok=True)
    fixture = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    fixture.daemon_threads = True
    threading.Thread(target=fixture.serve_forever, daemon=True).start()
    entries = []
    for index, name in enumerate(["same-first", "same-second", "different-cwd"]):
        child = subprocess.Popen(["node", "-e", "setInterval(() => {}, 1000)"])
        children.append(child)
        record = dict(sessionId=name, token="fixture", port=fixture.server_port, pid=child.pid, cwd=str(project if index < 2 else work), startedAt=f"2026-01-0{3-index}T00:00:00.000Z", tuiModule=entry["tuiModule"])
        file = registry / f"{child.pid}.json"
        file.write_text(json.dumps(record))
        entries.append(file)
    ambiguous = cli("legacy-ambiguous")
    ambiguous.finish(1)
    check("legacy ambiguous selection still requires an id", "several annotate sessions are live" in ambiguous.screen(), True)
    explicit = cli("legacy-explicit", "same-second")
    explicit.sees("fixture same-second")
    explicit.send("q")
    explicit.finish()
    for key, label in [("\x1b", "escape"), ("\x03", "ctrl-c")]:
        before = len(fixture_requests)
        picker = cli(label, "--interactive")
        picker.sees("same-second")
        check(label + " filters exact cwd", "different-cwd" in picker.screen(), False)
        picker.send(key)
        picker.finish()
        check(label + " does not attach or poll", fixture_requests[before:], [])
    for keys, selected in [("\x1b[B\r", "same-second"), ("\x1b[B\x1b[A\r", "same-first")]:
        picker = cli("select-" + selected, "--interactive")
        picker.sees("same-second")
        picker.send(keys)
        picker.sees("fixture " + selected)
        check("selection snapshot " + selected, any(path == f"/{selected}/api/snapshot" for path in fixture_requests), True)
        picker.send("q")
        picker.finish()
    entries[1].unlink()
    legacy = cli("legacy-cwd")
    legacy.sees("fixture same-first")
    legacy.send("q")
    legacy.finish()
    only = cli("one-candidate", "--interactive")
    only.sees("fixture same-first")
    check("one candidate bypasses picker", "Select session" in only.screen(), False)
    only.send("q")
    only.finish()
    piped = subprocess.run(["node", str(root / "bin" / "pi-annotation.ts"), "--interactive"], cwd=project, env=env, input="", capture_output=True, text=True, timeout=10)
    check("non-TTY exit", piped.returncode, 1)
    check("non-TTY explanation", "TTY" in piped.stderr, True)
    (work / "non-tty.txt").write_text(piped.stderr)
    entries[0].unlink()
    zero = cli("zero-candidates", "--interactive")
    zero.finish(1)
    check("zero candidates explains annotate", "run /annotate" in zero.screen(), True)
    for index in range(6):
        child = subprocess.Popen(["node", "-e", "setInterval(() => {}, 1000)"])
        children.append(child)
        record = dict(sessionId=f"resize-{index}", token="fixture", port=fixture.server_port, pid=child.pid, cwd=str(project), startedAt=f"2026-02-0{6-index}T00:00:00.000Z", tuiModule=entry["tuiModule"])
        file = registry / f"{child.pid}.json"
        file.write_text(json.dumps(record))
    picker_argv = ["env", "-i", *[f"{k}={v}" for k, v in env.items()], "node", str(root / "bin" / "pi-annotation.ts"), "--interactive"]
    tmux("new-session", "-d", "-s", "picker", "-x", "140", "-y", "24", "-c", str(project), shlex.join(picker_argv))

    def picker_screen():
        value = tmux("capture-pane", "-p", "-t", "picker")
        (work / "resize-picker-screen.txt").write_text(value)
        return value

    wait(lambda: "resize-5" in picker_screen(), "picker lists every candidate at 24 rows")
    tmux("resize-window", "-t", "picker", "-x", "140", "-y", "6")
    wait(lambda: tmux("display-message", "-p", "-t", "picker", "#{pane_height}").strip() == "6", "picker pane shrinks to six rows")
    tmux("send-keys", "-t", "picker", *["Down"] * 5)
    wait(lambda: "→ resize-5" in picker_screen(), "picker paints the selected last candidate after shrinking")
    check("shrunk picker screen is six rows", len(picker_screen().splitlines()), 6)
    before = len(fixture_requests)
    tmux("send-keys", "-t", "picker", "Enter")
    wait(lambda: any(path == "/resize-5/api/snapshot" for path in fixture_requests[before:]), "Enter attaches to the painted candidate")
    check("shrunk picker attaches only to the painted candidate", sorted({path.split("/")[1] for path in fixture_requests[before:]}), ["resize-5"])
    tmux("send-keys", "-t", "picker", "q")
    wait(lambda: subprocess.run(["tmux", "-f", "/dev/null", "-S", socket_path, "has-session", "-t", "picker"], env=env, capture_output=True).returncode != 0, "picker exits")
    fixture.shutdown()
    (work / "fixture-requests.json").write_text(json.dumps(fixture_requests, indent=2))
    (work / "result.json").write_text(json.dumps({"passed": checks}, indent=2))
    print(f"PASS {len(checks)} checks; evidence {work}", flush=True)
finally:
    for terminal in terminals:
        terminal.close()
    subprocess.run(["tmux", "-S", socket_path, "kill-server"], capture_output=True)
    for child in children:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=10)
    shutil.rmtree(socket_dir)
