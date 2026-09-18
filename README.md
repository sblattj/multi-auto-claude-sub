# multi-auto-claude-sub (`macsub`) — Claude Code account switcher with auto-login

**Switch between multiple Claude Code subscription accounts** — and when a saved
account's tokens have expired, `macsub` **logs back in for you**: first headlessly
from a saved claude.ai web session, then by driving your browser in a background
tab using CDP focus emulation (no window stealing, no manual clicking).

```sh
npm install -g multi-auto-claude-sub

macsub add personal        # vault the account you're logged into right now
# …log into your other account with `claude login`, then:
macsub add work
macsub swap work           # switch Claude Code accounts; auto-heals expired tokens
macsub ls                  # every account with access/refresh expiry at a glance
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
  2. refresh token alive → refresh (outside locks, CAS re-vault — refresh tokens
     are one-time-use)
  3. saved claude.ai `sessionKey` cookie → fully headless re-login, no browser
  4. **browser agent**: opens its own tab on the Anthropic OAuth page, emulates
     page focus (CDP `Emulation.setFocusEmulationEnabled`) so a **background tab**
     can click the focus-gated Authorize button, fills your email, optionally your
     password (only if you stored it in the Keychain), and captures the
     `localhost` callback — then installs the fresh tokens
  5. everything failed → prints the two manual commands

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
macsub ls | current | rm <name>
macsub swap <name>      (alias: use)
macsub refresh [name]
macsub login <name> [--store-password]         force the re-login ladder
macsub doctor                                  paths, keychain, locks, Chrome port
```

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
