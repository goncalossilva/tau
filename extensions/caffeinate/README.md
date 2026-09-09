# Caffeinate

`caffeinate` prevents system sleep during agent runs, including retries, automatic compaction, and queued follow-ups. It releases the inhibitor when the agent settles or the session closes or reloads. Display sleep settings remain unchanged.

macOS uses `caffeinate -i`; Linux uses `systemd-inhibit --what=sleep` and requires an accessible, authorized logind service. Linux's sleep lock can also block manual suspend; lid-close and forced-sleep behavior remain OS-policy decisions. If inhibition is unavailable, Pi warns once per load, on the first failed attempt, and continues normally. There are no commands or settings; disable the extension through Pi's package configuration if unwanted.
