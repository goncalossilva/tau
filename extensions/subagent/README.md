# Subagent

Use background Pi agents to investigate competing hypotheses, run independent experiments in parallel, or handle bounded subtasks whose detailed exploration would clutter the main context.

The main agent gets one `subagent` tool with four actions:

| Action   | Arguments                                      | Behavior                                                                   |
| -------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| `start`  | `goal`, `prompt`, optional `model`, `thinking` | Starts a child and returns its ID without waiting for the answer.          |
| `status` | Optional `id`                                  | Lists children, or shows one child's activity and latest response.         |
| `steer`  | `id`, `message`                                | Redirects a running child or continues its conversation after it finishes. |
| `stop`   | `id`                                           | Cancels the child and closes its process.                                  |

Completed answers arrive automatically when the parent's current run settles. If that run is interrupted, completed answers are still added to its history without restarting the cancelled parent. The main agent can keep working instead of checking repeatedly.

## Tasks, models, and thinking

`goal` is a short label of a few words. `prompt` contains the full task: relevant context, constraints, files to work on, and the result needed. Children start with fresh conversations, not copies of the parent's history.

Children **share the parent's checkout**. Separate processes do not isolate file changes. The tool guidance tells the parent to assign non-overlapping edits, including its own work, and preserve other agents' changes.

The model and thinking level default to the parent's settings when the child starts. `model` accepts an exact model ID or `provider/model` ID. `thinking` accepts the levels Pi supports, but an explicit override must also be supported by the selected model. The UI shows the actual model and thinking level. Later changes in the parent do not change existing children.

Match model capability to the task. Favor faster, less capable models for mechanical work and well-defined, bounded tasks. Favor more capable models for complex, ambiguous, or high-stakes work. Override the parent's model in either direction when there is a clear benefit. Choose model and thinking level independently. If no suitable alternative is known to be available, omit `model` to inherit.

The built-in model and thinking-level guidance favors inheritance. Choose a different model or thinking level only when the task clearly benefits from different model capabilities or reasoning effort. The built-in [customizable recommendations](#selection-recommendations) suggest these thinking levels:

- **Low:** mechanical searches and extraction.
- **Medium:** bounded edits or tests with a well-defined approach.
- **High:** non-trivial implementation tasks, cross-cutting changes, and security or concurrency review with a reasonably understood problem and direction.
- **Extra-high:** difficult, open-ended reasoning that requires resolving substantial uncertainty or evaluating competing explanations and approaches. Ambiguous debugging and difficult investigations are examples.

These are recommendations, not fixed tiers. There is no automatic upgrade or downgrade, or separate model-selection call.

`steer` is cooperative: a running child receives the message after its current tool batch, before its next model call. It does not interrupt an in-flight shell command. An idle child starts another turn with its existing history.

## Selection recommendations

Override or extend the task guidance in `<agent-dir>/subagent.json`, normally `~/.pi/agent/subagent.json`. This is an optional, agent-global file. There are no project overrides or configuration commands. Run `/reload` after editing it.

The file is an array of overrides and additions, **not a replacement for the built-in recommendations**. All four built-ins (`low`, `medium`, `high`, `xhigh`) are enabled by default. A missing file or `[]` leaves the defaults unchanged.

For example, using illustrative model IDs:

```json
[
  {
    "id": "low",
    "model": "provider/fast-model"
  },
  {
    "id": "medium",
    "model": "provider/coding-model",
    "thinking": "inherit"
  },
  {
    "id": "high",
    "model": "inherit",
    "thinking": "high"
  },
  {
    "id": "xhigh",
    "model": "provider/strong-model"
  },
  {
    "id": "security-review",
    "when": "Reviewing authentication, authorization, or trust boundaries.",
    "model": "provider/strong-model",
    "thinking": "high"
  }
]
```

| Field      | Meaning                                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| `id`       | Required stable identifier. An existing ID merges supplied fields into that default. A new ID adds a recommendation. |
| `when`     | Task guidance for the parent. Omit it to keep the built-in description. Required for a new recommendation.           |
| `model`    | Exact `provider/model` ID, or `"inherit"` to recommend the parent's model.                                           |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `"inherit"`.                                           |
| `enabled`  | Optional boolean. Set `false` to exclude a recommendation from the guidance. Defaults to enabled.                    |

A new recommendation requires `when` and at least one of `model` or `thinking`, even if disabled. Built-in IDs are labels, not inferred thinking levels: `"id": "medium"` can recommend `"thinking": "inherit"` or any supported level. Strings are trimmed, duplicate IDs and unknown fields are errors, and invalid configuration reports its path and prevents the parent extension from loading rather than silently using defaults.

Only supplied fields override defaults. In the example, `low` keeps its built-in task description and `low` thinking recommendation while gaining a preferred model. `high` explicitly recommends inheriting the parent's model. Unchanged fields continue receiving improvements to the built-ins. Existing recommendations retain their order; new ones are appended in file order. Order is not routing priority.

These settings change **advice**, not execution defaults or allowed choices. The effective recommendations appear in the tool description and parent instructions. The parent still decides which advice applies and chooses model and thinking independently. Omitting a field in the file keeps its built-in recommendation; `"inherit"` explicitly recommends omitting that tool argument. Do not pass the literal string `inherit` to the tool.

Model IDs are checked for `provider/model` syntax, not availability at configuration load. A model must be known and usable when actually selected, and an explicit thinking level must be supported by it. Explicit selection failures remain errors, with no silent substitution. Disabling a recommendation does not prohibit its model or thinking level.

## Display and cancellation

A compact running count appears only while children are active. With Tool Display Mode and an embedding-capable editor, it joins the composer's working indicator, including when only children are running. Otherwise it appears above the composer. Pi's tool-expansion shortcut, normally **Ctrl+O**, reveals rows above the composer with each child's status, goal, model, and thinking level. There is no separate shortcut or transcript viewer.

Completed rows remain while you read the current response and disappear on your next request. Active children and pending approvals stay visible. Steering a hidden child shows it again; hiding rows does not stop processes or remove conversations from `status` and `steer`. Automatic completion reports and extension-injected prompts do not clear recent rows.

Completed answers reach the main agent and remain in session history, but their internal report messages are hidden from the chat. The main agent's response is the user-facing result.

Ghostty's title spinner stays active while children are working, even when the parent is idle. Subagent emits session-scoped `subagent:start` and `subagent:end` events with `{ sessionKey }` when the first child starts work and the last finishes. These aggregate events include startup, follow-ups, answer finalization, and cancellation cleanup, in all modes. Retained idle conversations do not count as active work. Approval dialogs keep the title's waiting-for-input marker.

While children or Review tasks are active, Escape asks **“Cancel all ongoing work?”**. **Enter** confirms cancellation of the parent and all active background work. Escape again or **No** dismisses the confirmation without stopping anything. Existing dialogs keep their own Escape handling, and idle children do not require confirmation. `stop` still cancels one child directly without affecting others.

Whole-run parent cancellation also stops active children during tool execution or retry backoff. An independently aborted child run is reported as `aborted`, retaining its available partial answer, and can still be continued with `steer`. This differs from `stop`, which closes the child process. Pi's retry-only cancellation (`abortRetry()`, including native retry Escape) does not currently report whole-run cancellation.

Idle conversations remain available until stopped or the parent session closes. Reload, session replacement, and exit stop children and join their processes, pipes, pending startup, and approval requests. Navigating to another conversation branch also stops children so their answers cannot arrive on the wrong branch. Shutdown clears queued directions and requests a native abort before sending SIGTERM. Startup or unresponsive requests cannot block this indefinitely; SIGKILL is the final fallback.

Children are marked with `TAU_SUBAGENT_CHILD=1`. They do not get the delegation tool or Telegram integration themselves. The parent also sets `TAU_SUBAGENT_UNSANDBOXED_APPROVAL=1` to advertise support for forwarding sandbox approval requests. These are internal launch markers, not user configuration or permission grants.

## Sandbox approvals

Children load normal Pi configuration, authentication, and extensions from the parent's agent directory and use the parent's project-trust decision. Pi's `--approve` flag trusts project-local resources; it does not approve sandbox permission requests. This is not a clone of arbitrary in-memory SDK configuration.

When Tau's Sandbox is loaded, it explicitly passes its **current session policy** to the child, including temporary changes. A blocked or uninitialized parent sandbox prevents starting a child. A child still needs its own working sandbox prerequisites. Permissions subsequently granted to one child do not automatically grant access to its siblings or parent.

This policy applies to the child's Bash tool, including nested calls through codemode. It does not sandbox the Pi process, other tools, or MCP servers. MCP subprocesses run with the child's host permissions.

Standard child selection, confirmation, and text-input requests appear in the parent UI, labelled with the child's ID and goal. A single queue handles these requests and the parent's Sandbox approvals. Cancelling a queued child removes its request without dismissing another child's dialog. No agent message counts as permission; only the user's actual response is returned to the child. Non-interactive sandbox policy remains non-interactive, and requests without a parent UI are denied.

Pi does not queue arbitrary extension dialogs. This integration waits for an already-open Pi prompt, but unrelated extensions can still open their own dialogs without joining the approval queue. RPC also cannot display custom TUI components; multiline editor requests are cancelled because Pi does not provide cancellable forwarding for them.

## Lifetime and output

Child histories and full answers live in a private temporary directory. Answers injected into the parent's context are bounded; truncated answers include a path to the full text. Follow-ups do not overwrite earlier answer files. `status` provides a bounded snapshot rather than streaming entire transcripts into the parent.

Those temporary files are removed when the parent session closes or reloads. The answers already delivered to the parent remain in its normal history. There is no daemon, restart recovery, automatic worktree creation, task scheduler, or agent-profile configuration.

The extension requires the `pi` executable on PATH and supports macOS and Linux.

## References

The design draws on Pi's [official subagent example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent), [mjakl/pi-subagent](https://github.com/mjakl/pi-subagent), and the delegation guidance in [Codex](https://developers.openai.com/codex/subagents), [Claude Code](https://code.claude.com/docs/en/sub-agents), and [Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation/). It uses Pi's native RPC protocol rather than adopting another orchestration framework.
