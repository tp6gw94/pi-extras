# quota-resume

[繁體中文](README.zh-TW.md)

When a subscription quota runs out and the server gives a future reset time, `quota-resume` waits in the current session. After the reset, the extension sends this fixed message once:

```text
Continue the unfinished task.
```

The original prompt and completed tool results stay in the conversation. The extension does not resend the prompt, change models, use a paid fallback, or query usage endpoints.

## Supported providers

- Direct Claude subscriptions use `anthropic`. The extension recognizes `rate_limit_error` only when the unified subscription quota headers report `rejected` or `rate_limited`. Claude CLI bridges are not supported.
- OpenCode Go uses `opencode-go`. The extension recognizes `GoUsageLimitError` and reads `Retry-After`.
- OpenAI Codex uses `openai-codex`. The extension recognizes `usage_limit_reached` in HTTP errors and raw stream events. It reads an explicit reset time or the remaining seconds.

A generic HTTP 429, API token limit, or request rate limit is not enough to identify an exhausted subscription quota.

The extension preserves each provider's authentication, model overrides, and request options, including OpenCode's `x-opencode-session` header. Only the main agent's final failed turn creates a waiting record. Nested calls do not create records.

## Waiting and resuming

If the response has no valid future reset time, the extension shows a notification without resuming. When a session reopens after a saved reset time, the extension can still resume once from a previously valid waiting record.

## Cancellation and saved state

`/quota-resume cancel` cancels the wait. In the TUI, Escape also cancels the wait and still passes through to Pi. These actions also cancel the wait:

- New input.
- A user bash command.
- A new task started by a custom message.
- An aborted run.
- A model change.
- A session switch, fork, or session tree navigation.

Restoring the original model when reopening a session does not cancel the wait. Quitting or reloading Pi preserves the waiting record. Reopening the same session and branch restores the wait. The extension cannot resume while Pi is closed.

An idle RPC `abort` does not trigger a public extension event, so it cannot cancel the wait. RPC clients can cancel with `/quota-resume cancel` or new input. The extension does not use private APIs or change Pi core to bypass this limit.

The extension sends at most one resume message per waiting record. It marks the record as `consumed` and saves it in the session before sending the message. If the process crashes after saving the record but before sending the message, that resume is lost.

## Local verification

```sh
npm run typecheck
node --test --test-timeout=60000 extensions/quota-resume/test/*.test.mjs
node extensions/quota-resume/test/runtime-fixture.mjs 20
```

The third command starts a local test server that listens only on `127.0.0.1`. It prints a temporary directory, a `launch.sh` command, and log paths. `launch.sh` starts Pi with temporary settings. The test prompt is `Finish the fixture task.`. The same launch command reopens the same session to check whether the waiting record persists. Settings, fake credentials, and sessions stay in the system temporary directory. The fixture does not use personal credentials.

The SDK and RPC subprocess tests use Pi 1.3.0 with a local HTTP test server. The native Codex tests connect to a local WebSocket server. Terminal input contract tests do not replace tests in a real TUI.

Claude's unified headers are not a stable public API. Passing local tests does not verify behavior when a real subscription quota runs out.
