# telegram (prototype)

A pi extension + local daemon that lets you interact with pi via a Telegram bot.

## Install

When working from a source checkout, install dependencies from the repository root:

```bash
npm install
```

## Config

Bot token lookup order:

1. `PI_TELEGRAM_BOT_TOKEN`
2. macOS Keychain (`service=pi.telegram`, `account=bot-token`)
3. Legacy fallback: `~/.pi/agent/telegram/config.json`

The config file is still used for pairing state:

```json
{
  "pairedChatId": 123456789
}
```

## Usage (in pi)

- Pair Telegram globally (starts the daemon and registers this window session):

```text
/telegram pair
```

First time:

- pi will ask for the bot token and save it to macOS Keychain (or the config file on non-macOS systems)
- pi will show a 6-digit PIN

- Status:

```text
/telegram status
```

- Unpair globally (revokes Telegram pairing, disconnects attached windows, and terminates headless sessions):

```text
/telegram unpair
```

## Usage (in Telegram)

- `/pin 123456` – complete global pairing
- `/sessions` – list sessions
- `/session new [path]` – create a new headless session in `/path`, `~/path`, or the system temp directory if omitted; if the directory does not exist, the bot asks you to reply `Yes` to create it
- `/session N` – switch active session and replay unread replies (or the latest completed reply if none are unread)
- `/session quit` – quit the current headless session
- `/session quit N` – quit a specific headless session
- `/unpair` – unpair Telegram and terminate headless sessions
- `/esc` – abort current run in the active session
- plain text – send to the active session (queued as follow-up if the agent is busy, or held until compaction finishes)

## Notes

- Attached interactive pi windows appear in Telegram `/sessions` as `[window]` sessions.
- `/session new [path]` creates daemon-owned `[headless]` sessions.
- If `/session new [path]` targets a missing directory, the bot asks you to reply `Yes` to create it; any other reply cancels.
- Headless sessions are owned by the daemon and are terminated on `/unpair` or daemon shutdown.
- Switching to a session replays unread replies, not just the latest one.
- Inactive-session activity notifications are deduped for the same session until you switch sessions, a different session notifies, or the cooldown elapses.
- The daemon is started on-demand by `/telegram pair`, auto-restarts when a paired window opens, and stays alive while paired so Telegram can create headless sessions even when no windows are connected.
- Output mirrored to Telegram is the assistant’s final text at `turn_end`.
  - For short messages we try Telegram `Markdown` formatting; if Telegram rejects it, we fall back to plain text.
  - Long messages are sent as plain text chunks.
- System/daemon messages are sent in italics.
- When a session starts compacting, Telegram receives `[session N] compacting`.
- Messages sent during compaction are queued and delivered after compaction finishes.
- While the active session is busy, the daemon sends Telegram `typing…` chat actions periodically.
