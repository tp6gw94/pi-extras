# Ego Browser

[繁體中文](README.zh-TW.md)

`ego_browser` operates one Ego Lite TaskSpace. The tool is registered with `deferred` exposure, so its schema costs no context until the model loads it with `tool_search`. Enable that tool with `"defaultTools": ["+tool_search"]`, or name `ego_browser` in `defaultTools` or `--tools` to declare it from the start. A manual task needs no classifier. An automated task takes a bounded candidate list, and Jev selects one candidate ID, never a program, selector, or input text. The extension also ships the model-invoked [ego-browser-tools skill](skills/ego-browser-tools/SKILL.md).

## Tool contract

`schema.ts` defines the `begin`, `observe`, `act`, `run`, `finish`, and `release` request union under the wrapper `{ "request": <Request> }`.

- `begin` takes a numeric `space.attach` or a `space.create` name and returns a task token. The contract fixes the goal, `allowedOrigins`, `allowedActions`, `text`, `evidenceDir`, `deadline`, and `maxActions`. `text` maps string keys to input values.
- `observe` stores the raw snapshot and optionally runs checks and takes a screenshot. It does not parse the Ego snapshot format.
- `act` accepts navigate, click, fill, select, and press. A ref target must carry an observation ID from the same page, and the action round compares that observation's documentId and URL before dispatch. This does not guarantee ref identity after arbitrary DOM repaints within the same document. CSS and Ego semantic selectors work manually. fill and select accept only contract `textKey` values.
- `run` takes at most 32 candidates, deterministic checks, actions, and a time budget. A candidate is a CSS selector for a native control. A fill or select candidate whose current control value already equals the contract text for its textKey is not offered to the classifier and is not executed. Manual `act` has no such limit. Each step drops done fill and select candidates, asks for one choice, rechecks, dispatches, waits for the condition, and stores the next observation in the same CLI round. DOM changes return stale and are not retried.
- `finish` requires a reviewed observation with passing checks. The tool rechecks in the same Ego round and dispatches finish once. A failed check never dispatches finish. Repeated calls do not close the space twice.

`actionsUsed` is cumulative for the task. The contract `maxActions` caps the whole task, and the run `budget.maxActions` caps one `run` call counted from that call's start. A navigation, fill, click, select, or press consumes one action.

Checks support visible, value, text, and url. text uses rendered innerText and does not treat textContent from hidden children as visible. Each check returns actual, expected, and pass or fail. Only a non-empty set where every check passes produces `checks_passed`. DONE is a recheck request, not proof of success.

Each result includes actionsUsed, classifierCalls, checks, observation, tracePath, mayHaveLateEffects, and issues. Model usage returns to Pi too. A failed result sets isError, and structuredContent still carries the report.

`release` takes only `task` and releases the current executor's local lease without a browser call or closing the space. It works after the contract deadline. A busy task returns `busy`. Repeated release does not touch a newer lease. Release stopped tasks before the next task, but inspect uncertain effects first.

Frozen tasks permit bounded `observe` within the remaining contract deadline, with the same ownership, dialog, and origin guards. Observation never unfreezes a task. `mayHaveLateEffects` remains true after observation and release. Released tasks reject browser work.

`diagnostics` retains the result path, stage, bounded actual `after` checks captured before native wait, and inner or transport errors. Results publish atomically. Cancellation never promotes a saved success. Navigation and native wait share a decreasing round budget. The 30-second manual cap is unchanged. A `null` actual on a `text` or `value` check can mean that the selector matched no element, so compare the selector with the stored snapshot. A page title is not evidence of the DOM. Diagnostics are not automatic proof of a cause.

```json
{
	"request": { "op": "release", "task": "<task token from begin>" }
}
```

## Execution and limits

Ego is the only browser owner. Each call starts an `ego-browser nodejs` child, writes stdin, and closes it. There is no Playwright, CDP, claim, takeover, or arbitrary JS entry. The child inherits the basic execution environment and EGO variables, not model keys.

A task lives in the current executor's memory only and does not follow conversation branch rollback. active, frozen, finished, and released are explicit lifecycle states. Each space holds a cross-process exclusive lease and never steals an existing lease. A normal session_shutdown stops accepting work, cancels and waits for all accepted work, then releases the lease without finishing. Repeated shutdown waits on the same cleanup. A lock left by a crash needs the coordinator to confirm the old executor exited and check browser effects; nothing clears it automatically.

When a mutation may have been sent before cancellation or an error, the task freezes and reports `uncertain_effect`. Stopping the CLI or waiting for local work does not retract a browser action. Releasing the lease does not guarantee there are no late effects, so the coordinator must check browser effects before starting a new task. Do not replay, reload, close the page, or create another space. Ownership loss, dialogs, popups, and unexpected navigation also stop execution.

`allowedOrigins` checks navigation destinations, visible anchor destinations, and post-action URLs, but it is not a network sandbox. Forms, redirects, and page scripts can still send network requests. The automated flow does not support canvas, rich editors, custom widgets, iframes, or shadow DOM controls. Automated actions compare the whole facts set conservatively, so dynamic text, attributes, or check actual values can produce stale. This restriction is not relaxed.

Raw snapshots, check evidence, and traces go to `evidenceDir`. Screenshots happen only on request. These files can contain personal data from pages and are never uploaded automatically.

## Classifier configuration

The default is `typesafe/jev-latest` from the Pi registry. It uses Pi credential resolution and creates no separate HTTP client. Each call passes the remaining timeoutMs, the signal, and maxRetries 0. There is no default confidence threshold and no calibration claim.

`PI_EGO_CLASSIFIER_PROVIDER` and `PI_EGO_CLASSIFIER_MODEL` select any classifier configured in Pi. A compatible Kev provider can use the same entry, but Kev is not deployed or tested. Jev needs a working TYPESAFE_API_KEY.

## RPC integration

Install pi-extras in user scope so the rpc-subagents child inherits it. rpc-subagents loads enabled user-scoped extensions and skips project-scoped extensions, so a project-scoped install does not guarantee that the child loads ego-browser. `--extension <absolute path>` is a Pi CLI argument for starting a Pi process by hand; `rpc_subagents_run` has no extension setting.

Set the task settings to `tools: ["read", "ego_browser"]` and `webAccess: false`. The [rpc-subagents README](../rpc-subagents/README.md) documents the supported task settings. A tool list is not execution evidence; acceptance also checks the actual invocation and result. The parent only reads stored evidence and does not connect to the same browser again. One executor runs the whole contract.

## Direct call examples

The tool argument is always an object `{ "request": <Request> }`. The examples use placeholder values: a real task token, observation ID, and ref come from previous calls, and the evidence directory and deadline come from the contract.

```json
{
	"request": {
		"op": "begin",
		"space": { "create": "checkout-form" },
		"contract": {
			"goal": "Fill the form",
			"allowedOrigins": ["http://127.0.0.1:4317"],
			"allowedActions": ["navigate", "fill", "click"],
			"text": { "email": "test@example.invalid" },
			"evidenceDir": "/abs/evidence",
			"deadline": "2030-01-01T00:00:00Z",
			"maxActions": 12
		}
	}
}
```

A space created by `begin` holds a new tab page outside every allowed origin, so `observe` there returns `scope_violation` and freezes the task. Bootstrap with a `navigate` act to an allowed URL right after `begin` (the contract above lists `navigate` in `allowedActions`). The act report carries the observation to read next. Observe an attached in-scope page before choosing an element.

```json
{
	"request": {
		"op": "act",
		"task": "<task token from begin>",
		"page": "p1",
		"action": { "kind": "navigate", "url": "http://127.0.0.1:4317/" },
		"after": { "kind": "visible", "selector": "#email" }
	}
}
```

```json
{
	"request": {
		"op": "observe",
		"task": "<task token from begin>",
		"page": "p1",
		"checks": [
			{
				"id": "confirmed",
				"condition": { "kind": "text", "selector": "#confirmation", "includes": "Order confirmed" }
			}
		]
	}
}
```

```json
{
	"request": {
		"op": "act",
		"task": "<task token from begin>",
		"page": "p1",
		"observation": "<observation id from observe>",
		"action": { "kind": "fill", "target": { "ref": "ref=20" }, "textKey": "email" },
		"after": { "kind": "value", "selector": "#email", "equals": "test@example.invalid" }
	}
}
```

```json
{
	"request": {
		"op": "run",
		"task": "<task token from begin>",
		"page": "p1",
		"goal": "Fill email then submit",
		"candidates": [
			{
				"id": "email",
				"action": { "kind": "fill", "selector": "#email", "textKey": "email" },
				"after": { "kind": "value", "selector": "#email", "equals": "test@example.invalid" }
			},
			{
				"id": "submit",
				"action": { "kind": "click", "selector": "#submit" },
				"after": { "kind": "text", "selector": "#confirmation", "includes": "Order confirmed" }
			}
		],
		"checks": [
			{
				"id": "confirmed",
				"condition": { "kind": "text", "selector": "#confirmation", "includes": "Order confirmed" }
			}
		],
		"budget": { "maxActions": 3, "timeoutMs": 60000 }
	}
}
```

```json
{
	"request": {
		"op": "finish",
		"task": "<task token from begin>",
		"reviewedObservation": "<passing observation id>"
	}
}
```

## Offline verification

Run these commands from the repository root. The fake CLI implements only the vendor boundary in memory and files; it opens no browser.

```sh
node --test extensions/ego-browser/test/*.test.ts extensions/ego-browser/test/*.test.mjs test/package.test.ts
npm run typecheck
```

The registration test creates a real Pi session with the tool named in `tools` and verifies the deferred tool is active, reachable, and returns an unknown_task error result. The skill test loads the extension through the Pi SDK and validates every documented request payload against `ToolParametersSchema`. The runtime tests run the stdin EOF fake CLI and cover manual ref, raw snapshot, false DONE, stale, cancel, ownership, lease, and finish.

## Live harness

Only the single authorized runtime executor runs these commands. `EGO_SPACE_ID` is required; the harness attaches to p1 of that space only and creates no space. Other tabs and profiles stay untouched.

Start one fixture. It binds to 127.0.0.1 only, on port 4317 by default, and honors `PORT`.

```sh
node extensions/ego-browser/test/fixture.mjs
```

In another terminal, run a mode. `EGO_EVIDENCE_DIR` is optional and defaults to `extensions/ego-browser/test/.artifacts/live-<mode>-<timestamp>`.

```sh
export EGO_SPACE_ID=<authorized space id>
export EGO_EVIDENCE_DIR=<optional absolute evidence dir>
node extensions/ego-browser/test/live.ts <mode>
```

Except finish and ownership, every mode resets the fixture and navigates p1 first, and no success marker may exist initially.

- `manual`: scripted manual fill and click with observe. It is a tool baseline, not a large-model planning baseline.
- `fake`, `done`: real Ego with a fake classifier. done must cause zero mutation and `check_failed`.
- `jev`: real registry Jev. It incurs model cost. Success needs one order with a matching email.
- `ref`: takes the Email textbox `ref=N` from a stored observe snapshot, then fills with that ref and observation ID in the next one-shot round and verifies with a value check. A resend with the old observation ID must return stale. It does not submit an order.
- `limit`: fake classifier with run `budget.maxActions` 1. It must return `action_limit` after one action in that run, with the task's cumulative actionsUsed at 2 because the earlier navigation consumed one, and zero server mutations.
- `cancel`: the fixture delays order acceptance by 4 seconds. The harness cancels the click after the fixture receives the request. It must return `uncertain_effect` with mayHaveLateEffects true. It then polls `/state` and records late effects, and a repeated click must still return `uncertain_effect` while server received and mutations stay 1. No retry.
- `finish`: no reset and no navigation. Attach only, observe a check against the known `#confirmation`, and explicitly finish after it passes. This is the only mode that closes the space, so an authorized operator runs it alone in the last round.
- `ownership`: only begin, and observe when needed. One step must return `ownership_lost` with actionsUsed zero and no act, run, or finish request. An agent-owned space is not acceptance. Run it only after a separately approved human takeover; it never claims or takes over automatically.
- `hidden-text`: resets the fixture and navigates to `/?hidden-text=1`. A visible Pending container holds success text that is hidden, `display:none`, and `visibility:hidden`. observe must fail with actual Pending, finish must be refused, and server received and mutations must be zero. It does not click order or call the classifier.

Every mode writes `calls.json` and `summary.json` before throwing. The summary contains ok, failure, reasons, errors, checks, actions, classifierCalls, and the fixture `/state` server result. cancel also contains stateAtAbort, stateAfterLateEffect, and stateAfterRetryAttempt. The harness does not read stdin and does not block on approval.

The fixture `/state` returns received (arrival order), mutations, and orders. orders are in accepted order with seq and acceptedAt. `POST /delay?ms=N` delays acceptance of later orders, and `POST /reset` clears all state.

## Runtime status

The offline suite passes. The authorized runtime executor ran the live harness modes through finish and the hidden-text stop on the authorized space, and verified the RPC child invocation from `ego_browser` calls in the child event logs. The `ownership` mode needs an approved human takeover and has not run. Kev is untested. No speedup is claimed.
