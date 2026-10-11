#!/usr/bin/env python3
"""Drive a real `pi --mode rpc` run for pi-hooks end-to-end checks.

Sends one prompt per --prompt (in order, waiting for agent_settled between them),
answers pi-hooks' confirm dialog with --confirm, and prints a compact log of tool
calls, pi-hooks notifications/messages and the final reply. Exits non-zero if pi
does not settle before --deadline seconds.

Usage:
  python3 test/e2e/drive.py --cwd /path/to/project --confirm yes \
      --prompt "..." [--prompt "..."] [-- <extra pi args, e.g. --provider openai --model gpt-5>]
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.abspath(os.path.join(HERE, "..", "..", "index.ts"))


def short(s, n=400):
    s = s if isinstance(s, str) else json.dumps(s, ensure_ascii=False)
    return s if len(s) <= n else s[:n] + f"…(+{len(s) - n})"


def text_of(content):
    if isinstance(content, str):
        return content
    return "".join(c.get("text", "") for c in content or [] if isinstance(c, dict) and c.get("type") == "text")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cwd", required=True)
    ap.add_argument("--prompt", action="append", required=True)
    ap.add_argument("--confirm", default="yes", help="answer(s) for confirm dialogs, comma-separated in order; the last one repeats")
    ap.add_argument("--deadline", type=float, default=900)
    ap.add_argument("--pi", default=os.environ.get("PI_BIN", "pi"))
    ap.add_argument("--no-ext", action="store_true", help="do not add --extension (already installed)")
    ap.add_argument("rest", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    extra = [x for x in a.rest if x != "--"]
    cmd = [a.pi, "--mode", "rpc", "--no-session"] + ([] if a.no_ext else ["--extension", EXT]) + extra
    answers = [x.strip() for x in a.confirm.split(",")]
    t0 = time.time()

    def log(tag, msg=""):
        print(f"[{time.time() - t0:7.1f}s] {tag:<14} {msg}", flush=True)

    log("start", " ".join(cmd) + f"  (cwd={a.cwd})")
    proc = subprocess.Popen(cmd, cwd=a.cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def pump_err():
        for line in proc.stderr:
            log("stderr", short(line.decode(errors="replace").rstrip(), 300))

    threading.Thread(target=pump_err, daemon=True).start()

    def send(obj):
        proc.stdin.write((json.dumps(obj) + "\n").encode())
        proc.stdin.flush()

    settled = threading.Event()
    timer = threading.Timer(a.deadline, lambda: (log("DEADLINE", "pi did not settle; killing"), proc.kill()))
    timer.start()

    def reader():
        for raw in proc.stdout:
            try:
                r = json.loads(raw)
            except Exception:
                log("stdout?", short(raw.decode(errors="replace")))
                continue
            t = r.get("type")
            if t == "extension_ui_request":
                m = r.get("method")
                if m == "confirm":
                    log("ui.confirm", f"{r.get('title')} | {short(r.get('message'), 600)}")
                    ans = (answers.pop(0) if len(answers) > 1 else answers[0]) == "yes"
                    send({"type": "extension_ui_response", "id": r["id"], "confirmed": ans})
                    log("ui.confirm→", "yes" if ans else "no")
                elif m == "notify":
                    log(f"notify.{r.get('notifyType', 'info')}", short(r.get("message"), 1200))
                elif m in ("select", "input", "editor"):
                    send({"type": "extension_ui_response", "id": r["id"], "cancelled": True})
                    log("ui." + m, "cancelled")
            elif t == "tool_execution_start":
                args = r.get("args") or {}
                tgt = args.get("path") or args.get("command") or ""
                nested = " (nested)" if r.get("parentToolCallId") else ""
                log("tool", f"{r.get('toolName')}{nested} {short(tgt, 200)}")
            elif t == "tool_execution_end":
                res = r.get("result") or {}
                txt = text_of(res.get("content"))
                if "[pi-hooks]" in txt:
                    log("tool_result", short(txt[txt.index("[pi-hooks]"):], 400))
                if r.get("isError"):
                    log("tool_error", short(txt, 300))
            elif t == "message_end":
                msg = r.get("message") or {}
                role = msg.get("role")
                if role == "custom":
                    log("custom_msg", f"{msg.get('customType')}: {short(text_of(msg.get('content')), 1500)}")
                elif role == "assistant":
                    txt = text_of(msg.get("content"))
                    if txt.strip():
                        log("assistant", short(txt.strip(), 600))
                    if msg.get("stopReason") == "error":
                        log("model_error", short(msg.get("errorMessage"), 400))
            elif t == "agent_settled":
                log("settled")
                settled.set()
            elif t == "response" and not r.get("success", True):
                log("rpc_error", short(r))
        settled.set()

    threading.Thread(target=reader, daemon=True).start()
    ok = True
    for i, p in enumerate(a.prompt):
        settled.clear()
        log("prompt", short(p, 300))
        send({"id": f"p{i}", "type": "prompt", "message": p})
        settled.wait()
        if proc.poll() is not None:
            ok = False
            break
    timer.cancel()
    try:
        proc.stdin.close()
        proc.wait(timeout=20)
    except Exception:
        proc.kill()
    log("exit", f"code={proc.returncode} total={time.time() - t0:.1f}s")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
