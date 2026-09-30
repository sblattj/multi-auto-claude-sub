# Changelog

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
