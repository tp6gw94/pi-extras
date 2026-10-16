---
name: ego-browser-tools
description: Operate one Ego-owned TaskSpace with the ego_browser tool for live page verification, a manual browser task, a bounded Jev subgoal, or a screenshot with saved evidence. Use for real browser work, checked fields or clicks, or classifier-chosen actions. Not for shell browser scripts or direct ego-browser CLI use.
---

# Ego browser tools

`ego_browser` runs one bounded contract in one Ego TaskSpace. Manual tasks need no classifier. Automated tasks take a candidate list, and Jev picks one candidate ID per step. Jev never writes a program, selector, or input text.

[`../../schema.ts`](../../schema.ts) is the source of truth for the request schema. Read the live tool description before composing a request. Do not copy the schema into a task prompt.

## Run the task

1. Confirm that the browser use, the space, and any side effects are authorized. The coordinator chooses the delegation policy. An assigned executor runs the contract and does not redelegate it. Never hardcode a provider or model.
2. Begin one contract with one executor and one space for the whole goal. Give a goal, at least one allowed origin and action, the text key map, an absolute evidence directory, a future deadline, and an action cap. Include `navigate` in `allowedActions` whenever the space may need a bootstrap.
3. Choose the first step by what the space holds. The returned observation ID is the evidence handle for the next act or finish.
   - A space created by begin holds a new tab page outside every allowed origin. Bootstrap it with act `navigate` to an allowed URL, with an `after` check that the destination loaded. Ground that check in what you already know: a `url` check when the destination never redirects, or a `visible` check on a stable document element such as `body`. The act report carries the observation to read next, so skip the preliminary observe. Read its snapshot before you choose any page-specific selector or text. A page title is not evidence of the DOM.
   - An attached page already inside an allowed origin gets one observe before the first element is chosen.
   - An observe outside the allowed origins freezes the task as `scope_violation`. A frozen task stays frozen: never recover with a new space or a replay, and report the reason with its evidence.
4. Reuse the observation from the latest act or run instead of observing again. Act when one step is enough, or run a candidate list when the choice is bounded. Manual act accepts CSS or Ego semantic selectors, and a ref target also carries the observation ID from the same page. Never replay a mutation after stale, cancel, or uncertain_effect.
5. Finish closes the space. Call it only when the coordinator or user authorizes closure and the reviewed observation has non-empty, passing checks. The tool rechecks before closing. If checks pass but closure is not authorized, report `checks_passed` and leave the space open. If any check fails, do not finish; report the actual reason and evidence without claiming success.
6. Release the local lease with `{ "request": { "op": "release", "task": "<task token>" } }` when stopping or leaving the space open. This prevents a stopped task from blocking the next task. Release works after the deadline and makes no browser call. It does not cancel late effects. Check those effects before a new task. Frozen observe remains bounded by the contract deadline and all ownership, dialog, and origin guards. It never unfreezes the task.
7. Complete when the report shows `checks_passed` or `finished` for the goal. On a stop, report the reason and its evidence without claiming success. A task token is valid only in the executor that created it and only for that session.

## Read the report

The report carries `reason`, `actionsUsed`, `classifierCalls`, `checks`, `observation`, `tracePath`, `mayHaveLateEffects`, `issues`, and optional `diagnostics`. Diagnostics retain the stage, result path, actual after-check evidence before native wait, and inner errors. Inspect them on a wait failure. A passing pre-wait check does not prove the native wait succeeded. Uncertainty remains sticky after observe and release. `checks_passed` and `finished` are success reasons. `uncertain_effect` freezes the task after a mutation may have been sent, so check browser effects before a new task and do not replay. `ownership_lost`, dialogs, popups, and unexpected navigation stop execution. `stale` means the page changed, not that the action failed. Evidence files live in `evidenceDir` and can contain personal data, so send only what the goal needs.

## Call shape

The argument is always `{ "request": { ... } }`, and `op` selects begin, observe, act, run, finish, or release. Field definitions and full payloads for every operation are in [`../../schema.ts`](../../schema.ts) and the [extension README](../../README.md).

```json
{
	"request": {
		"op": "observe",
		"task": "<task token from begin>",
		"page": "p1",
		"checks": [
			{ "id": "confirmed", "condition": { "kind": "text", "selector": "#confirmation", "includes": "Order confirmed" } }
		]
	}
}
```

The angle-bracketed task token is a template. A real task token comes from begin.

## Delegate through RPC

When a coordinator dispatches this work through rpc-subagents, one task runs one contract in one space. Set the task tools to `["read", "ego_browser"]` and `webAccess` to false. A child that loads this extension is advertised this skill through `resources_discover`, even with `--no-skills`. The coordinator may pass this file's absolute path when the task explicitly instructs reading it, but that is not a required workaround. The coordinator can follow the sibling [rpc-subagents skill](../../../rpc-subagents/skills/rpc-subagents/SKILL.md) for the fleet contract. Acceptance reads the actual `ego_browser` invocation and result in the child event log, not the task's tool list. The parent reads stored evidence and never connects to the same browser.

Setup, limits, and the live harness are in the [extension README](../../README.md).
