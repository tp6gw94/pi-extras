import json
import os
import pathlib
import re
import shlex
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path(os.environ["ROOT"])
HERE = pathlib.Path(os.environ["HERE"])
PI_BIN = pathlib.Path(os.environ["PI_BIN"])
WORK = pathlib.Path(os.environ["WORK"])
EVIDENCE = pathlib.Path(os.environ["EVIDENCE"])
KEEP_WORK = os.environ.get("KEEP_WORK") == "1"
PI = PI_BIN / "pi"
HOME = WORK / "home"
AGENT = HOME / ".pi" / "agent"
PROJECT = WORK / "project"
SOCKET_DIR = WORK / "tmux"
SOCKET = SOCKET_DIR / "socket"
CAPTURES = EVIDENCE / "captures"
EDITOR = EVIDENCE / "editor.json"
EDITOR_REGULAR = EVIDENCE / "editor-regular.json"
MAIN = "pi"
REGULAR = "regular"

checks = []
failure = None
fake = None
fake_log = None
port = 0


def check(name, actual, expected):
    global failure
    if actual != expected:
        failure = f"{name}: {actual!r} != {expected!r}"
        raise AssertionError(failure)
    checks.append(name)
    print("PASS " + name, flush=True)


def check_true(name, condition, detail=""):
    if not condition:
        raise AssertionError(name + (f"  [{detail}]" if detail else ""))
    checks.append(name)
    print("PASS " + name, flush=True)


def wait(predicate, label, timeout=25):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.1)
    raise AssertionError("timeout: " + label)


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def tmux_env():
    value = dict(os.environ)
    value["HOME"] = str(HOME)
    return value


def tmux(*args):
    return subprocess.run(
        ["tmux", "-f", "/dev/null", "-S", str(SOCKET), *args],
        check=True,
        capture_output=True,
        text=True,
        env=tmux_env(),
    ).stdout


def fetch(path, timeout=3):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/{path}", timeout=timeout) as response:
            return response.read().decode()
    except OSError:
        return None


def model_count():
    value = fetch("count")
    return -1 if value is None else int(value)


def model_events():
    value = fetch("events")
    return [] if value is None else json.loads(value)


def model_last_user():
    value = fetch("last-user")
    return None if value is None else json.loads(value)


def model_held():
    value = fetch("held")
    return value == "true"


def release_model():
    return fetch("release")


def user_text(content):
    if isinstance(content, list):
        return "".join(part.get("text", "") for part in content)
    return content


def pane(target=MAIN):
    return tmux("capture-pane", "-p", "-t", target)


def pane_height(target=MAIN):
    return int(tmux("display-message", "-p", "-t", target, "#{pane_height}").strip())


def shot(name, target=MAIN):
    plain = pane(target)
    ansi = tmux("capture-pane", "-p", "-e", "-t", target)
    (CAPTURES / (name + ".txt")).write_text(plain, encoding="utf-8")
    (CAPTURES / (name + ".ansi")).write_text(ansi, encoding="utf-8")
    return plain, ansi


def full_capture(target=MAIN):
    plain = tmux("capture-pane", "-p", "-J", "-S", "-500", "-t", target)
    ansi = tmux("capture-pane", "-p", "-e", "-J", "-S", "-500", "-t", target)
    return plain, ansi


def press(char, target=MAIN):
    tmux("send-keys", "-t", target, "-l", char)
    time.sleep(0.12)


def special(key, target=MAIN):
    tmux("send-keys", "-t", target, key)
    time.sleep(0.12)


def type_text(text, target=MAIN):
    tmux("send-keys", "-t", target, "-l", text)
    time.sleep(0.18)


def command(text, target=MAIN):
    type_text(text, target)
    special("Enter", target)


def editor_text(path=EDITOR):
    try:
        return json.loads(path.read_text(encoding="utf-8"))["editor"]
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        return None


def wait_editor(text, label, path=EDITOR, timeout=15):
    return wait(lambda: editor_text(path) == text, label, timeout)


def save_editor(name, target=EDITOR):
    path = EVIDENCE / name
    if target.exists():
        path.write_text(target.read_text(encoding="utf-8"), encoding="utf-8")
    return path


STATUS = re.compile(r"\b(NORMAL|V-LINE|VISUAL|NOTE|LIST|HELP)(?: (\S+))? · (\d+):(\d+) · (\d+) notes?( · working)?")


def status(text=None, target=MAIN):
    for line in (pane(target) if text is None else text).splitlines():
        match = STATUS.search(line)
        if match:
            return {
                "tag": match.group(1),
                "row": int(match.group(3)),
                "col": int(match.group(4)),
                "notes": int(match.group(5)),
                "working": match.group(6) is not None,
            }
    return None


def wait_status(tag, notes=None, timeout=25):
    def predicate():
        value = status()
        if value is None or value["tag"] != tag:
            return None
        if notes is not None and value["notes"] != notes:
            return None
        return value

    return wait(predicate, f"mode {tag}", timeout)


def wait_position(row=None, col=None, timeout=15):
    def predicate():
        value = status()
        if value is None:
            return None
        if row is not None and value["row"] != row:
            return None
        if col is not None and value["col"] != col:
            return None
        return value

    return wait(predicate, f"caret {row}:{col}", timeout)


def wait_closed(timeout=20):
    return wait(lambda: status() is None, "mode closed", timeout)


def complete_events(request_id):
    return [event for event in model_events() if event.get("kind") == "complete" and event.get("requestId") == request_id]


def stream_numbers(text):
    return [int(value) for value in re.findall(r"stream line (\d+)", text)]


def setup():
    global fake, fake_log, port
    for directory in (WORK, EVIDENCE, CAPTURES, AGENT, PROJECT, SOCKET_DIR):
        directory.mkdir(parents=True, exist_ok=True)
    port = free_port()
    fake_log = (EVIDENCE / "fake.log").open("w", encoding="utf-8")
    fake = subprocess.Popen(["node", str(HERE / "fake-mode-openai.mjs"), str(port)], stdout=fake_log, stderr=subprocess.STDOUT)
    wait(lambda: fetch("count") == "0", "fake model ready", 20)
    (AGENT / "models.json").write_text(
        json.dumps({"providers": {"fake": {"baseUrl": f"http://127.0.0.1:{port}/v1", "api": "openai-completions", "apiKey": "fake", "models": [{"id": "fake-model", "name": "Fake model"}]}}}),
        encoding="utf-8",
    )
    base = {
        "HOME": str(HOME),
        "PI_CODING_AGENT_DIR": str(AGENT),
        "PATH": f"{PI_BIN}:{os.environ['PATH']}",
        "TERM": "xterm-256color",
        "LANG": "en_US.UTF-8",
        "SHELL": "/bin/sh",
    }
    main_env = dict(base, ANNOTATE_EDITOR_PROBE=str(EDITOR))
    main = [
        "env", "-i", *[f"{key}={value}" for key, value in main_env.items()], str(PI),
        "--tui-mode", "fullscreen", "--provider", "fake", "--model", "fake-model",
        "--extension", str(HERE / "annotation-mode-probe.ts"),
        "--extension", str(HERE / "editor-probe.ts"),
    ]
    tmux("new-session", "-d", "-s", MAIN, "-x", "140", "-y", "45", "-c", str(PROJECT), shlex.join(main) + "; echo PI_EXITED $?; sleep 600")
    wait(lambda: editor_text() is not None, "pi started", 60)


def start_regular():
    base = {
        "HOME": str(HOME),
        "PI_CODING_AGENT_DIR": str(AGENT),
        "PATH": f"{PI_BIN}:{os.environ['PATH']}",
        "TERM": "xterm-256color",
        "LANG": "en_US.UTF-8",
        "SHELL": "/bin/sh",
        "ANNOTATE_EDITOR_PROBE": str(EDITOR_REGULAR),
    }
    argv = [
        "env", "-i", *[f"{key}={value}" for key, value in base.items()], str(PI),
        "--tui-mode", "regular", "--provider", "fake", "--model", "fake-model",
        "--extension", str(HERE / "annotation-mode-probe.ts"),
        "--extension", str(HERE / "editor-probe.ts"),
    ]
    tmux("new-session", "-d", "-s", REGULAR, "-x", "120", "-y", "40", "-c", str(PROJECT), shlex.join(argv) + "; echo PI_EXITED $?; sleep 600")
    wait(lambda: editor_text(EDITOR_REGULAR) is not None, "regular pi started", 60)


def run():
    setup()
    version = subprocess.run([str(PI), "--version"], capture_output=True, text=True, env=tmux_env()).stdout.strip()
    (EVIDENCE / "setup.json").write_text(
        json.dumps({"pi": str(PI), "version": version, "extension": str(HERE / "annotation-mode-probe.ts"), "work": str(WORK), "modelPort": port, "tmuxSocket": str(SOCKET)}),
        encoding="utf-8",
    )

    command("MODE_FIXTURE")
    wait(lambda: model_count() == 1, "fixture request")
    wait(lambda: complete_events(1), "fixture response")
    plain, _ = shot("00-transcript")
    check_true("transcript renders markdown instead of source", "The cache has two layers and uses the docs." in plain and "**two layers**" not in plain)
    check_true("transcript renders fenced code and CJK", "```ts" in plain and "const limit = 3;" in plain and "日本語テキスト 🚀 完了" in plain)

    command('/probe-mode ' + json.dumps("DRAFT_DOC"))
    wait_editor("DRAFT_DOC", "draft prepared")
    entry = wait_status("NORMAL", 0)
    plain, ansi = shot("01-entry")
    check_true("status positions start at the transcript top", entry["row"] >= 1 and entry["col"] >= 1)
    check_true("caret uses reverse video", "\x1b[7m" in ansi)
    check("mode keys do not change the draft", editor_text(), "DRAFT_DOC")
    check_true("status line shows the mode hints", "v select" in plain and "s editor" in plain and "S submit" in plain and "Tab list" in plain)

    press("G")
    end = wait(lambda: (value := status()) and value["row"] > entry["row"] and value, "G moves to the transcript end")
    press("{")
    wait(lambda: (value := status()) and value["row"] < end["row"] and value, "{ moves to the previous message")
    press("g")
    press("g")
    wait(lambda: (value := status()) and value["row"] == 1 and value, "gg moves to the transcript start")
    press("j")
    wait_position(row=2)
    press("k")
    wait_position(row=1)
    press("3")
    press("j")
    wait_position(row=4)
    press("0")
    wait_position(col=1)
    check("mode keys still do not change the draft", editor_text(), "DRAFT_DOC")

    press("G")
    press("{")
    cjk = wait_status("NORMAL")
    press("{")
    wait(lambda: (value := status()) and value["row"] < cjk["row"] and value, "{ moves to the user message")
    press("}")
    wait_position(row=cjk["row"])
    press("0")
    wait_position(col=1)
    press("^")
    wait_position(col=2)
    press("l")
    wide_first = wait_position(col=4)
    press("l")
    wide_second = wait_position(col=6)
    check("wide glyphs move one character and two terminal columns", [wide_first["col"] - 2, wide_second["col"] - 4], [2, 2])
    press("e")
    word_end = wait(lambda: (value := status()) and value["col"] > 6 and value, "e moves to the word end")
    press("b")
    wait_position(col=2)
    press("w")
    word_start = wait(lambda: (value := status()) and value["col"] > 2 and value, "w moves to the next word")
    check_true("word motions move by word", word_end["col"] > 2 and word_start["col"] > 2)

    for _ in range(9):
        press("j")
    wait_position(row=cjk["row"] + 9)
    press("0")
    wait_position(col=1)
    press("^")
    wait_position(col=2)
    press("$")
    list_end = wait_position(col=12)
    check("line motions use the first non-blank and the row end", list_end["col"], 12)

    press("g")
    press("g")
    wait_position(row=1)
    special("C-d")
    half_down = wait(lambda: (value := status()) and value["row"] > 1 and value, "half page down")
    special("C-u")
    wait(lambda: (value := status()) and value["row"] < half_down["row"] and value, "half page up")
    special("C-f")
    page_down = wait(lambda: (value := status()) and value["row"] > half_down["row"] and value, "page down")
    special("C-b")
    wait(lambda: (value := status()) and value["row"] < page_down["row"] and value, "page up")
    before_page = status()
    special("NPage")
    wait(lambda: (value := status()) and value["row"] > before_page["row"] and value, "PageDown moves a page")
    after_page = status()
    special("PPage")
    wait(lambda: (value := status()) and value["row"] < after_page["row"] and value, "PageUp moves a page")

    press("G")
    press("{")
    last_unit = wait_status("NORMAL")
    press("{")
    wait(lambda: (value := status()) and value["row"] < last_unit["row"] and value, "unit previous")
    press("}")
    wait_position(row=last_unit["row"])

    press("v")
    visual = wait_status("VISUAL")
    press("l")
    wait(lambda: (value := status()) and value["col"] > visual["col"] and value, "selection extends")
    press("o")
    wait_position(col=visual["col"])
    press("V")
    wait_status("V-LINE")
    special("Escape")
    time.sleep(0.3)
    wait_status("NORMAL")

    press("V")
    press("a")
    wait_status("NOTE")
    type_text("cjk note")
    special("Enter")
    wait_status("NORMAL", 1)
    _, ansi = shot("02-cjk-note")
    check_true("saved notes are underlined", "\x1b[4m" in ansi)
    check("note keys still do not change the draft", editor_text(), "DRAFT_DOC")

    for _ in range(2):
        press("j")
    press("V")
    press("a")
    wait_status("NOTE")
    type_text("markdown note")
    special("Enter")
    wait_status("NORMAL", 2)
    press("3")
    press("j")
    press("V")
    press("a")
    wait_status("NOTE")
    type_text("code note")
    special("Enter")
    wait_status("NORMAL", 3)
    for _ in range(7):
        press("j")
    press("V")
    press("a")
    wait_status("NOTE")
    type_text("temp note")
    special("Enter")
    wait_status("NORMAL", 4)
    shot("03-four-notes")

    type_text("?")
    wait_status("HELP")
    plain, _ = shot("04-help")
    check_true("help lists the motions", "move by character" in plain)
    press("q")
    wait_status("NORMAL", 4)

    special("Tab")
    wait_status("LIST", 4)
    plain, _ = shot("05-list")
    check_true("the notes list shows saved notes", "cjk note" in plain and "temp note" in plain)
    press("e")
    wait_status("NOTE")
    plain, _ = shot("06-edit-note")
    check_true("editing shows the saved quote", "> 日本語テキスト" in plain)
    type_text(" edited")
    special("Enter")
    wait_status("LIST", 4)
    wait(lambda: "cjk note edited" in pane(), "edited note visible")
    for _ in range(3):
        press("j")
    wait(lambda: "> 4." in pane(), "list selection moves to the temp note")
    press("d")
    wait_status("LIST", 3)
    check_true("d deletes the selected note", "deleted" in pane())
    press("q")
    wait_status("NORMAL", 3)

    press("q")
    plain, _ = shot("07-quit-warning")
    check_true("q warns about unsent notes", "3 unsent notes; press again to quit" in plain)
    check("the warning keeps the draft", editor_text(), "DRAFT_DOC")
    press("q")
    wait_closed()
    wait_editor("DRAFT_DOC", "draft after quit")
    special("C-c")
    wait_editor("", "Ctrl-C before re-entry")
    command('/probe-mode ' + json.dumps("DRAFT_DOC"))
    wait_status("NORMAL", 3)
    shot("08-reentry")

    before_s = model_count()
    press("s")
    wait(lambda: (editor_text() or "").startswith("DRAFT_DOC") and "code note" in (editor_text() or ""), "s appends notes")
    wait_closed()
    expected = (
        "DRAFT_DOC\n"
        "> 日本語テキスト 🚀 完了\n\ncjk note edited\n\n"
        "> The cache has two layers and uses the docs.\n\nmarkdown note\n\n"
        "> ```ts\n> const limit = 3;\n> ```\n\ncode note\n\n"
    )
    check("s appends the exact quote format after the draft", editor_text(), expected)
    check("s does not call the model", model_count(), before_s)
    check_true("s reports the append", "appended 3 annotations" in pane())
    save_editor("editor-appended.json")
    shot("09-appended")
    special("C-c")
    wait_editor("", "Ctrl-C clears the restored editor")

    command("MODE_HOLD")
    wait(lambda: model_held(), "held model response")
    wait(lambda: "Holding current work." in pane(), "held response displayed")
    held_count = model_count()
    command('/probe-mode ' + json.dumps("DRAFT_FOLLOWUP"))
    wait_editor("DRAFT_FOLLOWUP", "follow-up draft prepared")
    wait_status("NORMAL")
    wait(lambda: (value := status()) and value["working"] and value, "busy marker")
    press("G")
    press("{")
    wait_status("NORMAL")
    press("a")
    wait_status("NOTE")
    type_text("followup note")
    special("Enter")
    wait_status("NORMAL", 1)
    press("S")
    wait(lambda: "Follow-up" in pane(), "follow-up queued")
    wait_closed()
    shot("10-followup-queued")
    check("S does not start a request before release", model_count(), held_count)
    wait_editor("DRAFT_FOLLOWUP", "S keeps the draft before release")
    check_true("the held response releases", release_model() == "true")
    wait(lambda: model_count() == held_count + 1, "follow-up request")
    wait(lambda: complete_events(held_count + 1), "follow-up response")
    payload = "> Holding current work.\n\nfollowup note\n\n"
    check("S sends the exact note payload", user_text(model_last_user()), payload)
    events = model_events()
    held_complete = next(index for index, event in enumerate(events) if event.get("kind") == "complete" and event.get("requestId") == held_count)
    follow_start = next(index for index, event in enumerate(events) if event.get("kind") == "request" and event.get("requestId") == held_count + 1)
    check_true("follow-up starts after the current turn completes", held_complete < follow_start)
    check("S sends one request", len([event for event in events if event.get("kind") == "request" and event.get("requestId") > held_count]), 1)
    wait(lambda: "Note received." in pane(), "follow-up reply")
    wait_editor("DRAFT_FOLLOWUP", "S keeps the draft after the reply")
    (EVIDENCE / "model-events-followup.json").write_text(json.dumps(events, indent=2), encoding="utf-8")

    special("C-c")
    wait_editor("", "Ctrl-C before the stream")
    stream_request = model_count() + 1
    command("MODE_STREAM")
    wait(lambda: "stream line 01" in pane(), "stream started", 20)
    command('/probe-mode ' + json.dumps("DRAFT_STREAM"))
    wait_editor("DRAFT_STREAM", "stream draft prepared")
    stream_entry = wait_status("NORMAL")
    wait(lambda: (value := status()) and value["working"] and value, "stream busy marker")
    plain, _ = shot("11-stream-entry")
    visible = stream_numbers(plain)
    wait(lambda: complete_events(stream_request), "stream response complete", 40)
    stream_idle = wait(lambda: (value := status()) and value["tag"] == "NORMAL" and not value["working"] and value, "stream idle", 20)
    plain, _ = shot("12-stream-complete")
    check("streaming keeps the caret row", stream_idle["row"], stream_entry["row"])
    check("streaming keeps the caret column", stream_idle["col"], stream_entry["col"])
    check("streaming does not follow new output", stream_numbers(plain), visible)
    check_true("streamed rows stay below the viewport", "STREAM_DONE" not in plain)
    press("G")
    wait(lambda: "STREAM_DONE" in pane(), "G reaches the streamed end")
    check_true("G moves the caret past the recorded position", status()["row"] > stream_entry["row"])
    press("q")
    wait_closed()
    wait_editor("DRAFT_STREAM", "stream draft after exit")
    special("C-c")
    wait_editor("", "Ctrl-C after the stream")

    command('/probe-mode ' + json.dumps("DRAFT_RESIZE"))
    wait_editor("DRAFT_RESIZE", "resize draft prepared")
    wait_status("NORMAL")
    press("a")
    wait_status("NOTE")
    words = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
    for index, word in enumerate(words):
        type_text("draft line " + word)
        if index < len(words) - 1:
            special("C-j")
    wait(lambda: "draft line one" in pane() and "draft line nine" in pane(), "nine note lines visible")
    plain, _ = shot("13-note-dock-45")
    check("a tall terminal shows every note line", plain.count("draft line "), 9)
    tmux("resize-window", "-t", MAIN, "-x", "140", "-y", "30")
    wait(lambda: pane_height() == 30, "terminal shrinks to 30 rows")
    wait_status("NOTE")
    plain, _ = shot("14-note-dock-30")
    check_true("a short dock keeps the last note line", "draft line nine" in plain)
    check_true("the dock hides the first note line at 30 rows", "draft line one" not in plain)
    check_true("the dock stays within a third of the terminal", plain.count("draft line ") <= 8)
    tmux("resize-window", "-t", MAIN, "-x", "140", "-y", "45")
    wait(lambda: pane_height() == 45, "terminal grows to 45 rows")
    wait(lambda: "draft line one" in pane() and "draft line nine" in pane(), "all note lines visible again")
    plain, _ = shot("15-note-dock-45-again")
    check("a taller terminal reveals the first note line", plain.count("draft line "), 9)
    special("Escape")
    time.sleep(0.3)
    wait_status("NORMAL")
    press("q")
    wait_closed()
    wait_editor("DRAFT_RESIZE", "resize draft after exit")
    special("C-c")
    wait_editor("", "Ctrl-C after resize")

    command('/probe-mode ' + json.dumps("DRAFT_EVICT"))
    wait_editor("DRAFT_EVICT", "eviction draft prepared")
    wait_status("NORMAL")
    press("G")
    press("a")
    wait_status("NOTE")
    type_text("evict note")
    special("Enter")
    wait_status("NORMAL", 1)
    special("C-e")
    wait(lambda: "PROBE DIALOG" in pane(), "external dialog takes the slot")
    plain, _ = shot("16-dialog")
    wait(lambda: "PROBE DIALOG" not in pane(), "external dialog closes", 15)
    wait_closed()
    wait_editor("DRAFT_EVICT", "editor restored after eviction")
    plain, ansi = shot("17-eviction-cleanup")
    check_true("eviction removes the caret paint", "\x1b[7m" not in ansi)
    type_text("X")
    wait_editor("DRAFT_EVICTX", "editor accepts input after eviction")
    special("C-c")
    wait_editor("", "Ctrl-C after eviction")
    command('/probe-mode ' + json.dumps("DRAFT_EVICT"))
    wait_status("NORMAL", 1)
    press("q")
    check_true("notes survive eviction", "1 unsent note; press again to quit" in pane())
    press("q")
    wait_closed()
    wait_editor("DRAFT_EVICT", "eviction draft after re-entry")
    special("C-c")
    wait_editor("", "Ctrl-C after eviction re-entry")

    command("/probe-arm-tree two layers")
    wait(lambda: "armed" in pane(), "tree probe armed")
    command('/probe-mode ' + json.dumps("DRAFT_TREE"))
    wait_editor("DRAFT_TREE", "tree draft prepared")
    wait_status("NORMAL", 1)
    press("G")
    press("{")
    wait_status("NORMAL")
    press("a")
    wait_status("NOTE")
    type_text("tree note")
    special("Enter")
    wait_status("NORMAL", 2)
    press("v")
    wait_status("VISUAL")
    _, ansi = shot("18-tree-selection")
    check_true("a selection is painted before the rebuild", "\x1b[7m" in ansi and "\x1b[4m" in ansi)
    special("C-t")
    wait(lambda: "selection cleared: conversation changed" in pane(), "selection cleared after the rebuild", 20)
    wait_status("NORMAL", 2)
    plain, ansi = shot("19-tree-rebuild")
    check_true("the rebuild drops stale note marks", "\x1b[4m" not in ansi)
    check_true("the rebuild removes the selected message", "stream line 01" not in plain)
    check("the rebuild keeps both notes", status()["notes"], 2)
    press("q")
    check_true("the kept notes still ask before quitting", "2 unsent notes; press again to quit" in pane())
    press("q")
    wait_closed()
    wait_editor("DRAFT_TREE", "tree draft after exit")
    special("C-c")
    wait_editor("", "Ctrl-C before the tree re-entry")
    command('/probe-mode ' + json.dumps("DRAFT_TREE"))
    wait_status("NORMAL", 2)
    press("q")
    press("q")
    wait_closed()
    wait_editor("DRAFT_TREE", "tree draft after the final re-entry")
    special("C-c")
    wait_editor("", "Ctrl-C after the tree scenarios")

    command('/probe-set-editor ' + json.dumps("DRAFT_EXIT"))
    wait_editor("DRAFT_EXIT", "exit draft prepared")
    type_text("abc")
    wait_editor("DRAFT_EXITabc", "editor typing restored")
    special("C-c")
    wait_editor("", "Ctrl-C restored")
    command("/annotation-mode")
    wait_status("NORMAL")
    press("v")
    wait_status("VISUAL")
    special("Escape")
    time.sleep(0.3)
    wait_status("NORMAL")
    press("q")
    press("q")
    wait_closed()
    command("/quit")
    wait(lambda: "PI_EXITED" in full_capture()[0], "pi exited", 30)
    plain, ansi = full_capture()
    (CAPTURES / "20-exit-transcript.txt").write_text(plain, encoding="utf-8")
    (CAPTURES / "20-exit-transcript.ansi").write_text(ansi, encoding="utf-8")
    check_true("the exit transcript has no caret", "\x1b[7m" not in ansi)
    check_true("the exit transcript has no selection or note paint", "\x1b[4m" not in ansi)
    check_true("the exit transcript has no dock", "NORMAL ·" not in plain)
    check_true("the exit transcript keeps the conversation", "The cache has two layers and uses the docs." in plain)

    start_regular()
    command("/annotation-mode", REGULAR)
    wait(lambda: "annotation-mode: needs fullscreen mode" in pane(REGULAR), "regular mode refusal")
    plain, _ = shot("21-regular-refusal", REGULAR)
    check_true("regular mode does not open the dock", "NORMAL ·" not in plain)
    type_text("regular draft", REGULAR)
    wait_editor("regular draft", "regular editor works", EDITOR_REGULAR)
    special("C-c", REGULAR)
    wait_editor("", "regular Ctrl-C works", EDITOR_REGULAR)
    command("/quit", REGULAR)
    wait(lambda: "PI_EXITED" in full_capture(REGULAR)[0], "regular pi exited", 30)
    shot("22-regular-exit", REGULAR)

    sessions = AGENT / "annotation" / "sessions"
    files = [] if not sessions.exists() else list(sessions.iterdir())
    check("the mode needs no annotation server", files, [])

    result = {
        "passed": checks,
        "evidence": str(EVIDENCE),
        "work": str(WORK),
        "pi": version,
        "modelPort": port,
    }
    (EVIDENCE / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"PASS {len(checks)} checks; evidence {EVIDENCE}", flush=True)


def cleanup(passed):
    global fake, fake_log
    subprocess.run(["tmux", "-f", "/dev/null", "-S", str(SOCKET), "kill-server"], capture_output=True, env=tmux_env())
    if fake is not None and fake.poll() is None:
        fake.terminate()
        try:
            fake.wait(timeout=10)
        except subprocess.TimeoutExpired:
            fake.kill()
            fake.wait()
    if fake_log is not None:
        fake_log.close()
    shutil.rmtree(SOCKET_DIR, ignore_errors=True)
    if not KEEP_WORK:
        if passed:
            shutil.rmtree(WORK, ignore_errors=True)
        else:
            print(f"WORK kept at {WORK}", flush=True)


def main():
    global failure
    passed = False
    try:
        run()
        passed = True
    except Exception as error:
        failure = str(error)
        print("FAIL " + failure, file=sys.stderr, flush=True)
        EVIDENCE.mkdir(parents=True, exist_ok=True)
        (EVIDENCE / "result.json").write_text(json.dumps({"passed": checks, "error": failure, "evidence": str(EVIDENCE), "work": str(WORK)}, indent=2), encoding="utf-8")
    finally:
        cleanup(passed)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
