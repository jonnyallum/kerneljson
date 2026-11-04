# Ordinary Telegram text

Jonny asked on 4 November 2026 to be able to send an ordinary message to KernelJSON. The deployed parser currently accepts only slash commands and records ordinary text as `MALFORMED`.

This change routes nonempty ordinary text from the existing authenticated private chat to the configured mission analyst model. It uses no tools and cannot admit or mutate a task. The answer is stripped of control characters, limited to 3000 characters, and queued through the existing durable reply outbox. The inbox records the Telegram update ID, a hash of the input, the `CHAT` command kind and the outcome; it does not store raw user text. Duplicate updates produce one reply. A model failure gets a fixed answer without leaking provider details. Unknown slash commands retain the usage response. `/status`, `/task`, `/brief`, `/review`, `/change` and memory commands retain their existing routes.

This is a stateless answer to each message. It does not yet remember conversation turns, make tool calls or form the multi-agent shared room. Those are separate follow-on work.

## Release

1. Apply `20261104122321_telegram_plain_text.sql` to the exact production database used by the Telegram worker. Verify the resulting `telegram_inbox_command_check` includes `CHAT` before starting new code.
2. Deploy the worker image containing this change, register the worker deployment with Restate, and verify `TelegramOperator` remains present. The existing `MISSION_ANALYST_MODEL` provider configuration supplies the answer model; if absent, ordinary text receives a fixed unavailable response.
3. From the configured private chat, send a harmless ordinary message. Confirm one `CHAT`/`ANSWERED` inbox row, one delivered reply, and no task admission. Then send `/status` to verify the command route. Re-send the same update only in a test environment to check deduplication.
4. If the new worker fails, restore the prior image. The new `CHAT` constraint value can remain; it does not affect old workers.

No bot token, model key, chat ID or database URL belongs in logs, notes or pull requests.
