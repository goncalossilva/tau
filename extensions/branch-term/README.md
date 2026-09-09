# Branch terminals

`/branch` forks the selected conversation without switching the current session. Inside tmux, `--branch-tmux-layout` chooses `window`, `split-right`, or `split-down`; a `/branch` argument overrides that setting.

`--branch-term` takes precedence over tmux and accepts a Bash launcher template. Use unquoted `{cwd}` and `{session}` placeholders for path arguments. `{command}` supplies a single command-string argument, suitable for a launcher's command option or `bash -c`. Do not add shell quotes around placeholders; they are already quoted. If neither `{session}` nor `{command}` appears, the fork path is appended. The launcher runs in the session's working directory with the current environment.

A failed launcher produces a recovery command. Reloading or closing the original Pi session stops observing launcher failures but does not close user-owned terminals.
