/** Swap algorithm (SPEC §4): warn → locks → re-vault outgoing → install target
 *  → mergeOauthAccount → setActive → release. Plus installFreshCredential
 *  (§4 steps 4-5 only) for other seats' login flows. */

import type {
  AccountRecord,
  ActiveState,
  CredentialBlob,
  OauthAccount,
  SwapResult,
  Vault,
} from "../types.js";
import { withClaudeLocks } from "./locks.js";
import { detectLiveSessions } from "./sessions.js";

export interface SwapOptions {
  env?: NodeJS.ProcessEnv;
  /** inject session detection (tests); default scans the real config dir */
  detectSessions?: () => Promise<string[]>;
}

export async function swap(
  vault: Vault,
  active: ActiveState,
  toName: string,
  opts: SwapOptions = {},
): Promise<SwapResult> {
  const env = opts.env ?? process.env;
  const detect = opts.detectSessions ?? (() => detectLiveSessions({ env }));
  const from = await vault.activeAccount();
  const target = await vault.get(toName);
  if (!target) {
    return {
      outcome: "failed-unknown-account",
      from,
      to: toName,
      warnings: [],
      detail: `no vaulted account named "${toName}"`,
    };
  }

  // step 1: warn on live sessions (never kill)
  const warnings: string[] = [];
  try {
    warnings.push(...(await detect()));
  } catch (e) {
    warnings.push(`session detection failed: ${errMsg(e)}`);
  }

  // step 2: locks (§3 order); steps 3-6 inside; release in finally
  return withClaudeLocks(
    async () => {
      // step 3: re-vault the outgoing account — the LIVE copy is the truth
      // (CC rotates both tokens in place). Skipped when no active account.
      let outgoingLive: CredentialBlob | null = null;
      let outgoingAcc: OauthAccount | null = null;
      if (from !== null) {
        try {
          outgoingLive = await active.readCredential();
        } catch (e) {
          return unreadable(from, toName, warnings, `readCredential: ${errMsg(e)}`);
        }
        try {
          outgoingAcc = await active.readOauthAccount();
        } catch (e) {
          return unreadable(from, toName, warnings, `readOauthAccount: ${errMsg(e)}`);
        }
        if (outgoingLive === null) {
          warnings.push(`no live credential for outgoing account "${from}" — vault copy left unchanged`);
        }
        const outgoingRec = await vault.get(from);
        if (outgoingRec) {
          const updated: AccountRecord = { ...outgoingRec, savedAt: Date.now() };
          if (outgoingLive) updated.credential = outgoingLive;
          if (outgoingAcc) updated.oauthAccount = outgoingAcc;
          await vault.save(updated);
        } else {
          warnings.push(`active account "${from}" has no vault record — skipped re-vault`);
        }
      }

      // step 4: install target credential; keychain push failure = swap fails
      try {
        await active.writeCredential(target.credential);
      } catch (e) {
        let detail = `credential install failed: ${errMsg(e)}`;
        if (outgoingLive) {
          try {
            await active.writeCredential(outgoingLive);
            detail += "; outgoing credential restored";
          } catch (e2) {
            detail += `; RESTORING OUTGOING CREDENTIAL FAILED: ${errMsg(e2)}`;
          }
        } else {
          detail += "; no outgoing credential to restore";
        }
        return { outcome: "failed-keychain-push", from, to: toName, warnings, detail };
      }

      // steps 5-6: merge identity, mark active. On failure: best-effort restore,
      // then propagate (no SwapOutcome code exists for this case).
      try {
        await active.mergeOauthAccount(target.oauthAccount);
        await vault.setActive(toName);
      } catch (e) {
        if (outgoingLive) {
          try {
            await active.writeCredential(outgoingLive);
          } catch {
            // already failing; original error is the story
          }
        }
        if (outgoingAcc) {
          try {
            await active.mergeOauthAccount(outgoingAcc);
          } catch {
            // already failing
          }
        }
        throw e;
      }

      return {
        outcome: warnings.length > 0 ? "swapped-with-warnings" : "swapped",
        from,
        to: toName,
        warnings,
        detail: target.oauthAccount.emailAddress,
      };
    },
    { env },
  );
}

export interface InstallOptions {
  env?: NodeJS.ProcessEnv;
}

/** SPEC §4 steps 4-5 only, under the §3 locks: install a freshly minted
 *  credential + identity. Login flows call this after minting new tokens;
 *  callers update the vault/config themselves. */
export async function installFreshCredential(
  active: ActiveState,
  rec: AccountRecord,
  opts: InstallOptions = {},
): Promise<void> {
  const env = opts.env ?? process.env;
  await withClaudeLocks(
    async () => {
      await active.writeCredential(rec.credential);
      await active.mergeOauthAccount(rec.oauthAccount);
    },
    { env },
  );
}

function unreadable(from: string | null, to: string, warnings: string[], detail: string): SwapResult {
  return { outcome: "failed-active-state-unreadable", from, to, warnings, detail };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
