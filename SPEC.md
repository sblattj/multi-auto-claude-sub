# multi-auto-claude-sub (`macsub`) — SPEC v0.1

Switch between multiple Claude Code **subscription accounts**, with **auto-login on
swap**: when a vaulted account's tokens are dead, macsub re-logs-in automatically —
first headlessly via a saved web session, then by driving the browser in the
background using CDP focus emulation (technique from
[sblattj/cdp-toolkit](https://github.com/sblattj/cdp-toolkit)).

- npm package: `multi-auto-claude-sub` · binary: `macsub` · Node ≥22 · zero runtime deps
- Language: TypeScript (NodeNext ESM, strict)

## 1. Active-state contract (what "logged in as X" means)

Claude Code's own state, which we snapshot/restore:

| OS | OAuth credential blob | Identity |
|---|---|---|
| macOS | Keychain generic password, service `Claude Code-credentials` (acct attr = OS username). JSON: `{"claudeAiOauth":{"accessToken","refreshToken","expiresAt"(ms),"refreshTokenExpiresAt"(ms),"scopes":[…]}}`. Keychain is **authoritative**; `~/.claude/.credentials.json` is a 0600 mirror. | `~/.claude.json` key `oauthAccount`: `{emailAddress, accountUuid, organizationUuid, organizationName, …}` |
| Linux/Windows | `~/.claude/.credentials.json` (chmod 600) authoritative | same |

- `CLAUDE_CONFIG_DIR` env overrides the config home for BOTH the credentials file
  and `.claude.json`. `~/.claude/.claude.json` is a legacy alternate config path
  (valid if it contains `.oauthAccount`) — check it after the primary.
- `~/.claude.json` holds ~100 unrelated keys (`theme`, `projects`, `mcpServers`, …):
  we merge ONLY the `oauthAccount` key, never wholesale-replace the file.

## 2. Vault layout

```
$MACSUB_HOME (default ~/.macsub)/
  config.json                 {"activeAccount": "work" | null}
  accounts/<slug>.json        AccountRecord (see src/types.ts), mode 0600
```

Opt-in login password (macOS) stored as Keychain generic password, service
`macsub-password`, acct attr = account name — never in vault files.

## 3. Locking protocol (Claude Code's own locks — order matters)

Claude Code refreshes tokens under `proper-lockfile`-compatible **directory locks**.
A swap that lands inside CC's refresh window gets clobbered. Acquire, in order:

1. `<configHome>/.oauth_refresh.lock` — dir lock, stale after 60s, touch every 5s while held
2. `~/.claude.lock` — legacy, same stale/touch parameters
3. `~/.claude.json.lock` — held only around config-file writes, stale after 10s

Release in reverse order. Implementation must be mkdir-based (a competing CC
process creates the same directory) with a stale lock broken when older than the
stale window.

## 4. Swap algorithm (`macsub swap <name>`)

1. **Warn on live sessions** (never kill): scan `~/.claude/sessions/<pid>.json`
   (pid alive?) and `~/.claude/ide/<port>.lock`; collect warnings.
2. Acquire locks (§3 order).
3. **Re-vault the outgoing account**: read live credential + `oauthAccount` and
   save into the outgoing account's record — CC rotates BOTH tokens in place, so
   the vault copy is stale the moment CC refreshed; the live copy is the truth.
   (If active account is null — e.g. first use — skip.)
4. Install target credential:
   - macOS: **delete-all-then-add** keychain item `Claude Code-credentials`
     (`claude auth logout` leaves duplicate items; a plain update can leave
     `security find-generic-password -w` returning the OLD token). Delete in a
     loop until `find-generic-password` fails, then
     `security add-generic-password -U -s "Claude Code-credentials" -a <user> -w <json>`.
     Keychain push failure = swap FAILS (`failed-keychain-push`), restore outgoing credential.
   - else: atomic write of `.credentials.json` (write tmp, chmod 600, rename).
   - Mirror write to the non-authoritative location too (keep the pair in sync).
5. `mergeOauthAccount(target.oauthAccount)` into live config.
6. Update `config.json` → `activeAccount = <name>`; release locks.
7. Post-swap (outside locks): run the health ladder (§5) on the installed account.

## 5. Token health ladder

Per account, in order, stop at first success:

- **L0 fresh**: `accessToken.expiresAt > now + 60_000` → done.
- **L1 refresh**: `refreshTokenExpiresAt > now` →
  `POST https://platform.claude.com/v1/oauth/token`
  `{"grant_type":"refresh_token","refresh_token":…,"client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e"}`.
  Refresh tokens are **one-time-use**: do the POST **outside all locks**, then
  CAS-commit into the vault only if the vaulted `refreshToken` fingerprint is
  unchanged since the read (another process may have rotated it). Re-vault after.
- **L2 web session** (headless, no browser): if `webSession.sessionKey` exists and
  not `stale`: `GET https://claude.ai/api/account` with cookie
  `sessionKey=<v>` → `memberships[0].organization.uuid` and confirm email;
  then PKCE (S256) `POST https://claude.ai/v1/oauth/<org_uuid>/authorize`
  (headers `Origin: https://claude.ai`, `Referer: https://claude.ai`) →
  authorization_code → exchange at `platform.claude.com/v1/oauth/token` → install
  (§4 steps 4–5 under locks). On `session_stale_relogin` error: retry once with
  Claude-Code-only scopes; if it still fails set `webSession.stale = true` → L3.
- **L3 browser agent** (§6): full OAuth with CDP-driven browser.
- **L4 manual**: notify + print: run `claude login` as that account, then
  `macsub add <name>` to re-capture.

## 6. Browser auto-login agent (L3) — CDP

Attach-only (never launches Chrome). Base URL: `$CDP_BASE` if set, else probe
`http://127.0.0.1:{9222,9223,9333,9224}` via `GET /json/version` — never assume
9222 silently; report which port. All Chrome-only.

1. Bind localhost callback listener on `127.0.0.1:<ephemeral>` FIRST; authorize URL:
   `https://platform.claude.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A<port>%2Fcallback&scope=user%3Ainference%20user%3Asessions%3Aclaude_code&code_challenge=<S256(verifier)>&code_challenge_method=S256&state=<random>`
   (client_id `9d1c250a-e61b-44d9-88ed-5944d1962f5e`).
2. Open OWN tab: `GET <base>/json/new?url=<authorize-url>` — never drive a tab we
   didn't create; close it via `/json/close/<targetId>` in a `finally`.
3. One WebSocket to the target's `webSocketDebuggerUrl`. Command protocol: JSON
   `{id, method, params}` over WS, resolve by id. Needed methods:
   `Emulation.setFocusEmulationEnabled`, `Runtime.evaluate`
   (`returnByValue:true`), `Input.insertText`, `Input.dispatchMouseEvent`.
4. `Emulation.setFocusEmulationEnabled {enabled:true}` immediately — Anthropic's
   authorize page gates its Authorize button on `document.hasFocus()`/
   visibility; emulation makes a background tab report focused WITHOUT stealing
   OS focus. Always disable in `finally`.
5. Classify-and-act loop (`Runtime.evaluate` with a self-contained expression
   that returns `{kind, x, y, disabled}` for the first match):
   - `button` with visible text `Authorize` → trusted click:
     `Input.dispatchMouseEvent` `mouseMoved` → `mousePressed` → `mouseReleased`
     at the button's bounding-rect center (skip if `disabled || aria-disabled`).
   - `input[type=email]` → focus it (`el.focus()`), verify
     `document.activeElement === el`, `Input.insertText` the email, then click
     Continue the same trusted-click way.
   - password field → fill ONLY if `options.password` provided; otherwise notify
     user + keep polling (they may type it themselves).
   - "check your email" / OTP state → notify, poll until timeout.
6. Callback handler: on `GET /callback?code=&state=` verify `state`, respond 200
   with a tiny "macsub: login captured — you can close this tab" page, close tab,
   disable emulation. Exchange code (§5 L1 endpoint,
   `grant_type:"authorization_code"`, `code_verifier`), then install under locks.

Fill safety (burned recipes from cdp-toolkit): `Input.insertText` delivers to
whatever is focused — prove focus landed before inserting; verify field value
after; React inputs may need a `change` event dispatched via evaluate.

## 7. CLI surface

```
macsub add <name> [--capture-web]   # vault current login (re-vault if name exists); --capture-web pulls claude.ai sessionKey via CDP if a debug port is live
macsub ls                           # table: name, email, access-exp, refresh-exp, web-session
macsub current                      # active account + live oauthAccount email
macsub swap <name>                  # alias: use — §4 + §5
macsub rm <name>
macsub refresh [name]               # L1 only
macsub login <name> [--store-password]  # force L2/L3; --store-password saves keychain password for future auto-fills (prompt, never echo)
macsub doctor                       # config paths, keychain access, locks present, Chrome debug port, per-account token expiries
```

Exit codes: 0 ok, 1 failure, 2 warnings-only.

## 8. Security

- Vault files 0600; dir 0700. Never log tokens (`log.redact`).
- Passwords: opt-in, OS keychain only, never in vault JSON, never echoed.
- Only ever drive tabs the agent itself created; always clean up (close tab,
  disable focus emulation) even on error.

## 9. README / SEO requirements (when published)

- H1: `multi-auto-claude-sub (macsub) — Claude Code account switcher with auto-login`
- Exact-match strings on first screen: "claude code account switcher",
  "switch claude accounts", "multiple Claude accounts", "swap Claude subscription accounts".
- Copy-paste block: install (npm i -g multi-auto-claude-sub) + first `add`/`swap`.
- Section "Is using multiple Claude accounts allowed?" — ToS discussion (real search
  demand: "claude multiple accounts tos/ban").
- Comparison table: claude-swap / cc-switch / caam / macsub — our row: auto-login on swap.
- Attribution: focus-emulation technique from sblattj/cdp-toolkit; lock protocol
  reverse-engineered by the claude-swap project.

## 10. Research provenance (2026-09-17 fan-out)

Mechanics verified against source of realiti4/claude-swap (locks, refresh CAS,
keychain layout), Dicklesworthstone/coding_agent_account_manager (keychain
authoritative, pull/push), ming86/cc-account-switcher (keychain `-U`, legacy
config path), Symbioose/claude-account-switcher (delete-all-then-add, logout
duplicates), North-web-dev/claude-cookie-session (headless sessionKey→PKCE flow,
`session_stale_relogin` fallback), Claude Code 2.1.275 binary strings (client_id,
authorize/token endpoints, callback port range, lock file names), and
sblattj/cdp-toolkit `src/tools/focus-emulation.ts` (CDP focus emulation + trusted
click). Novelty check: no existing tool combines vault swap + auto re-login.
