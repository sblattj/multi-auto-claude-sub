# Changelog

## Unreleased

- `macsub login <name> --timeout <duration>` sets how long the browser agent
  waits (default 3m). `MACSUB_LOGIN_TIMEOUT` sets it for every browser login,
  swaps included. A bad flag is rejected; a bad env value is warned about and
  ignored.
- When claude.ai asks for an emailed one-time code, the agent now waits at
  least 10 minutes from that point instead of timing out at the original
  3-minute deadline.
- A login that times out now suggests `--timeout`.

## 0.1.9 — 2026-10-08

- Fix browser auto-login stalling on a blank tab. The login agent opened its
  tab with `/json/new?url=<encoded>`, but Chrome reads the whole query string
  as the URL, so the tab stayed on `about:blank` and `macsub login` timed out
  after 180s with `last page state: unknown at blank`. The tab now opens at
  the authorize URL. A live CDP regression test covers it.

## 0.1.8 — 2026-09-29

- Warn about environment credential overrides in `current` and `doctor`.
  Claude Code authenticates with env vars (`ANTHROPIC_AUTH_TOKEN` >
  `ANTHROPIC_API_KEY` > apiKeyHelper > `CLAUDE_CODE_OAUTH_TOKEN` > … >
  keychain) before the keychain subscription login, so a shell exporting any of
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` or
  `ANTHROPIC_BASE_URL` made `claude` silently bill a different account while
  `macsub current` reported the vault account as live. `current` now prints a
  warning block naming each set var, and `doctor` gains an env-override check
  that exits 2 (warnings only) when any is set.
