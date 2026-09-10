# Subagent

Delegate work to background Pi agents and follow up with them.

The main agent gets one `subagent` tool with four actions:

| Action   | Arguments                                      | Behavior                                                                   |
| -------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| `start`  | `goal`, `prompt`, optional `model`, `thinking` | Starts a child and returns its ID without waiting for the answer.          |
| `status` | Optional `id`                                  | Lists children, or shows one child's activity and latest response.         |
| `steer`  | `id`, `message`                                | Redirects a running child or continues its conversation after it finishes. |
| `stop`   | `id`                                           | Cancels the child and closes its process.                                  |

Completed answers arrive automatically when the parent's current run settles. If that run is interrupted, completed answers are still added to its history without restarting the cancelled parent. The main agent can keep working instead of checking repeatedly.

## Tasks and thinking

`goal` is a short label of a few words. `prompt` contains the full task: relevant context, constraints, files to work on, and the result needed. Children start with fresh conversations, not copies of the parent's history.

Children **share the parent's checkout**. Separate processes do not isolate file changes. The tool guidance tells the parent to assign non-overlapping edits, including its own work, and preserve other agents' changes.

The model and thinking level default to the parent's settings when the child starts. `model` accepts an exact model ID or `provider/model` ID. `thinking` accepts the levels Pi supports, but an explicit override must also be supported by the selected model. The UI shows the actual model and thinking level. Later changes in the parent do not change existing children.

The guidance is deliberately simple: use low thinking for simple lookups, medium for ordinary tasks, and high or extra-high for hard problems. There is no automatic downgrade or separate model-selection call.

`steer` is cooperative: a running child receives the message after its current tool batch, before its next model call. It does not interrupt an in-flight shell command. An idle child starts another turn with its existing history.

## Display and cancellation

A compact running count appears above the composer only while children are active. Pi's tool-expansion shortcut, normally **Ctrl+O**, reveals rows with each child's status, goal, model, and thinking level in the same place. Expansion follows Pi's existing state, including Tool Display Mode. There is no separate shortcut or transcript viewer.

Completed rows remain while you read the current response and disappear on your next request. Active children and pending approvals stay visible. Steering a hidden child shows it again; hiding rows does not stop processes or remove conversations from `status` and `steer`. Automatic completion reports and extension-injected prompts do not clear recent rows.

Completed answers reach the main agent and remain in session history, but their internal report messages are hidden from the chat. The main agent's response is the user-facing result.

Escape cancels active children when no user prompt is open. It also lets Pi cancel a running parent turn. When a dialog is open, Escape dismisses that dialog instead. `stop` targets one child without affecting others.

Idle conversations remain available until stopped or the parent session closes. Reload, session replacement, and exit stop children and join their processes, pipes, pending startup, and approval requests. Navigating to another conversation branch also stops children so their answers cannot arrive on the wrong branch. Shutdown clears queued directions and requests a native abort before sending SIGTERM. Startup or unresponsive requests cannot block this indefinitely; SIGKILL is the final fallback.

Children are marked with `PI_SUBAGENT=1`. They do not get the delegation tool themselves.

## Sandbox approvals

Children load normal Pi configuration, authentication, and extensions from the parent's agent directory and use the parent's project-trust decision. Pi's `--approve` flag trusts project-local resources; it does not approve sandbox permission requests. This is not a clone of arbitrary in-memory SDK configuration.

When Tau's Sandbox is loaded, it explicitly passes its **current session policy** to the child, including temporary changes. A blocked or uninitialized parent sandbox prevents starting a child. A child still needs its own working sandbox prerequisites. Permissions subsequently granted to one child do not automatically grant access to its siblings or parent.

Standard child selection, confirmation, and text-input requests appear in the parent UI, labelled with the child's ID and goal. A single queue handles these requests and the parent's Sandbox approvals. Cancelling a queued child removes its request without dismissing another child's dialog. No agent message counts as permission; only the user's actual response is returned to the child. Non-interactive sandbox policy remains non-interactive, and requests without a parent UI are denied.

Pi does not queue arbitrary extension dialogs. This integration waits for an already-open Pi prompt, but unrelated extensions can still open their own dialogs without joining the approval queue. RPC also cannot display custom TUI components; multiline editor requests are cancelled because Pi does not provide cancellable forwarding for them.

## Lifetime and output

Child histories and full answers live in a private temporary directory. Answers injected into the parent's context are bounded; truncated answers include a path to the full text. Follow-ups do not overwrite earlier answer files. `status` provides a bounded snapshot rather than streaming entire transcripts into the parent.

Those temporary files are removed when the parent session closes or reloads. The answers already delivered to the parent remain in its normal history. There is no daemon, restart recovery, automatic worktree creation, task scheduler, or agent-profile configuration.

The extension requires the `pi` executable on PATH and supports macOS and Linux.

## References

The design draws on Pi's [official subagent example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent), [mjakl/pi-subagent](https://github.com/mjakl/pi-subagent), and the delegation guidance in [Codex](https://developers.openai.com/codex/subagents), [Claude Code](https://code.claude.com/docs/en/sub-agents), and [Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation/). It uses Pi's native RPC protocol rather than adopting another orchestration framework.
