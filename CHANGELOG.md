# Changelog

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
