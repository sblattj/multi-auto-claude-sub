# multi-auto-claude-sub (`macsub`) — Claude Code account switcher with auto-login

**Switch between multiple Claude Code subscription accounts** — and when a saved
account's tokens have expired, `macsub` **logs back in for you**: first headlessly
from a saved claude.ai web session, then by driving your browser in a background
tab using CDP focus emulation (no window stealing, no manual clicking).

```sh
npm install -g multi-auto-claude-sub

macsub add personal        # vault the account you're logged into right now
# …log into your other account with `claude auth login`, then:
macsub add work
macsub swap work           # switch Claude Code accounts; auto-heals expired tokens
macsub swap                # two accounts vaulted? bare swap toggles to the other one
macsub ls                  # every account: token expiry plus 5h and weekly usage
macsub usage               # usage bars for every account, and which one to use now
macsub best                # swap to the account whose weekly allowance expires soonest
```

`macsub` is for people juggling **multiple Claude accounts** — a personal Pro and a
work Max, a team plan and a solo plan — and want a **claude code account switcher**
that does the whole job: vault, **swap Claude subscription accounts** without
re-login, refresh tokens, and re-login automatically when refresh dies.

## Why this one

| | claude-swap / cswap | cc-switch | caam | **macsub** |
|---|---|---|---|---|
| Vault + swap subscription accounts | ✓ | ✓ (desktop) | ✓ | ✓ |
| Token refresh (keeps vault fresh) | ✓ | ✗ | ✗ | ✓ (CAS-safe) |
| Headless re-login from saved web session | ✗ | ✗ | ✗ | ✓ |
| **Auto-login on swap via browser agent** | ✗ | ✗ | partial¹ | ✓ |
| Background-tab OAuth (focus emulation) | ✗ | ✗ | ✗ | ✓ |

¹ caam can click through an already-logged-in browser; nobody else combines vault
swap + automatic re-login when tokens die.

## How it works

- **Vault** (`~/.macsub/accounts/`, 0600): each account stores its OAuth
  credential blob (macOS Keychain / `~/.claude/.credentials.json`) and identity
  (`oauthAccount` in `~/.claude.json`).
- **Swap**: takes Claude Code's own file locks, re-vaults the outgoing account
  (Claude Code rotates tokens in place — the live copy is the truth), installs the
  target's credentials + identity, never touches your other settings.
- **Auto-login ladder**, run on every swap:
  1. valid access token → done
  2. refresh token alive → refresh (CAS re-vault; refresh tokens are one-time-use).
     A swap refreshes the target *before* installing it, so running sessions never
     see an expired token. For the live account the refresh runs under Claude
     Code's own refresh lock, and a token a running session already refreshed is
     adopted instead of spent twice
  3. saved claude.ai `sessionKey` cookie → fully headless re-login, no browser
  4. **browser agent**: opens its own tab on the claude.ai OAuth page (the same
     subscription login `claude auth login` uses), emulates page focus (CDP
     `Emulation.setFocusEmulationEnabled`) so a **background tab** can click the
     focus-gated Authorize button, fills your email and submits the email form
     (never a Google/Apple/SSO button), optionally your password (only if you
     stored it in the Keychain), and captures the `localhost` callback, then
     installs the fresh tokens. If the browser is signed into a different
     claude.ai account, claude.ai emails you a login link: open it and the agent
     finishes the rest
  5. everything failed → prints why each step failed (refresh error, the page the
     agent stalled on) and the two manual commands

## Is using multiple Claude accounts allowed?

Short answer: running **multiple accounts** is against Anthropic's consumer ToS in
some situations (shared/duplicate accounts); separate accounts for separate
payers (you + your employer) is the normal case people switch for. This tool
switches between accounts *you already legitimately hold* — it does not bypass
rate limits, share one subscription, or pool accounts. See Anthropic's Usage
Policy for your situation. (`macsub` deliberately does **not** rotate accounts
mid-session to dodge limits — one active account at a time, like a human
switching.)

## Commands

```
macsub add <name> [--session-key <sk-ant-…>]   vault the current login
macsub ls | current | rm <name> | rename <old> <new>
macsub usage [--json]                          5h + weekly usage per account, and the best pick
macsub swap [name] [--best | --toggle]         (alias: use; `macsub best` = swap --best)
macsub mode [toggle|best]                      what a bare `macsub swap` does (default toggle)
macsub best --auto [--max-age 5m] [--timeout 4s]  unattended best swap (for a `claude` launcher)
macsub on-limit                                Claude Code StopFailure hook: swap to the best account, notify
macsub statusline                              status-line segment: every account's 5h/7d from the cache
macsub refresh [name]
macsub login <name> [--store-password]         force the re-login ladder
macsub doctor                                  paths, keychain, locks, Chrome port
```

## Usage and the best account

`macsub usage` reads the same numbers as Claude Code's `/usage` screen for every
vaulted account (5-hour session window, weekly window, per-model weekly limits,
extra-usage spend) and marks the best one to use right now. `macsub ls` shows the
same 5h and weekly percentages; readings marked `*` come from the last cached
snapshot (`~/.macsub/usage.json`) because the account's access token had expired.

Weekly allowance is use-it-or-lose-it, so **best** is the account whose unused
allowance expires fastest: weekly % left ÷ hours until the weekly reset.

| account | weekly used | resets in | left ÷ hours | pick |
|---|---|---|---|---|
| A | 90% | 7 days | 10 ÷ 168 ≈ 0.06 | |
| B | 10% | 1 day | 90 ÷ 24 = 3.75 | **B** |

Accounts at a limit are skipped (if all are, the one that frees up first wins), a
5-hour window with under 25% left counts against an account unless it resets
within 30 minutes, an account with under 5% of its week left only wins when
nothing else is usable, and near ties keep the current account so you don't
restart sessions for nothing. `macsub best` swaps to the pick; `macsub mode best`
makes a bare `macsub swap` do the same.

## Staying on the best account automatically

A swap changes the login for sessions started afterwards; sessions already
running keep the account they started with. So the useful moments to re-pick are
right before a new session starts and right after a session hits a limit.

**Before each new session.** `macsub best --auto` is built for a launcher: it
never opens a browser or prompts, keeps the current account without a request
when the cached usage (at most `--max-age` old, default 5m) still ranks it best,
gives up after `--timeout` (default 4s) instead of delaying the launch, and
always exits 0. It prints one line only when it swaps. A zsh/bash wrapper:

```sh
# >>> macsub auto-best >>>
claude() {
  case "${1-}" in
    agents|attach|auth|auto-mode|doctor|gateway|import|install|logs|mcp|plugin|plugins|project|rm|\
    setup-token|stop|kill|ultrareview|update|upgrade|-v|--version|-h|--help) ;;
    *) if [ "${MACSUB_AUTO:-1}" != 0 ] && command -v macsub >/dev/null 2>&1; then macsub best --auto; fi ;;
  esac
  command claude "$@"
}
# <<< macsub auto-best <<<
```

`MACSUB_AUTO=0 claude` skips it once.

**When a session hits a limit.** Claude Code runs `StopFailure` hooks when a turn
ends on an API error; `macsub on-limit` reads the hook payload, acts only on
`rate_limit`, swaps to the best account and posts a desktop notification (macOS)
saying where it went and to resume with `claude --continue`. In
`~/.claude/settings.json`:

```json
{
  "hooks": {
    "StopFailure": [
      { "matcher": "rate_limit", "hooks": [{ "type": "command", "command": "macsub on-limit", "timeout": 30 }] }
    ]
  }
}
```

Hooks run without your shell's PATH setup, so use an absolute path to `macsub`
(or a small script that sets PATH) if it lives under a Node version manager.
Several sessions limited at once make one swap: the rest see the lock and stay
quiet.

**Status line.** `macsub statusline` prints `5h/7d alpha* 2/0% · beta 11/32%`
(`*` = active, colored by the higher of the two, `→ beta` when another account is
the better pick). It reads only the cache, so it is fast and offline; when the
cache is older than 10 minutes it starts one detached `macsub usage
--refresh-cache` (at most once per 10 minutes across all sessions). Add its
output to your status line script, or use it as the whole status line:

```json
{ "statusLine": { "type": "command", "command": "macsub statusline" } }
```

Every automatic decision is logged to `~/.macsub/auto.log`.

## Corporate proxies (Zscaler, Netskope)

TLS-inspecting proxies re-sign HTTPS with a root certificate that only the OS
trusts, which makes Node's built-in fetch fail with `fetch failed` /
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. On Node ≥22.19 or ≥24.5, `macsub` adds the
OS certificate store (macOS Keychain, Windows store) to Node's roots at startup;
`macsub doctor` reports it and probes both endpoints. On older Node, run with
`NODE_OPTIONS=--use-system-ca`. `MACSUB_SYSTEM_CA=0` turns the behavior off.

## Browser agent setup

The login agent attaches to Chrome's DevTools endpoint — it never launches a
browser itself:

```sh
# fully quit Chrome, then:
open -a "Google Chrome" --args --remote-debugging-port=9222
macsub doctor      # should print: Chrome debug endpoint: http://127.0.0.1:9222
```

Any port works (`$CDP_BASE` overrides; common ports are probed). The agent only
drives a tab it created itself and always closes it and disables focus emulation
when done.

### Web session capture (enables headless re-login, ladder step 3)

While logged into claude.ai in your browser: DevTools → Application → Cookies →
copy the `sessionKey` value (starts with `sk-ant-`), then:

```sh
macsub add work --session-key sk-ant-…
```

(Stored in the vault file, mode 0600; never printed. When claude.ai rejects it as
stale, macsub marks it and falls through to the browser agent.)

### Password autofill (optional)

```sh
macsub login work --store-password   # prompts once, stores in macOS Keychain
```

macOS only; passwords never live in vault files.

## Security

- vault files 0600, keychain where available; tokens are redacted from all output
- Claude Code's own lock protocol respected on every write (no clobbered refreshes)
- the browser agent drives only its own tab, cleans up on every exit path

## Attribution

- CDP focus-emulation + trusted-click technique adapted from
  [sblattj/cdp-toolkit](https://github.com/sblattj/cdp-toolkit).
- Claude Code lock protocol and keychain layout documented by the open-source
  [claude-swap](https://github.com/realiti4/claude-swap) project and
  [caam](https://github.com/Dicklesworthstone/coding_agent_account_manager).

MIT License. Not affiliated with Anthropic.
