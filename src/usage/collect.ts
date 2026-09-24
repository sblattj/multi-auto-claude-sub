/** Read every vaulted account's usage, falling back to the last cached
 *  snapshot when a live read is not possible. */
import { readFile } from "node:fs/promises";
import type { AccountRecord, ActiveState, Vault } from "../types.js";
import type { FetchImpl } from "../oauth/client.js";
import { OAuthClient } from "../oauth/client.js";
import { assess, type TokenRefresher } from "../oauth/health.js";
import { refreshAccount } from "../pipeline.js";
import { pathsFor } from "../paths.js";
import { writeFileAtomic } from "../vault/store.js";
import { describeError } from "../util/net.js";
import { redact } from "../util/log.js";
import { fetchUsage, type UsageSnapshot } from "./usage.js";

export interface AccountUsage {
  name: string;
  email: string;
  usage?: UsageSnapshot;
  /** usage came from the cache because the live read failed or was skipped */
  cached?: boolean;
  /** why there is no live reading */
  error?: string;
}

export interface CollectOptions {
  /** refresh expired access tokens (L1 only, never a browser login) so their
   *  usage can be read; otherwise such accounts fall back to the cache */
  refresh?: boolean;
  fetchImpl?: FetchImpl;
  client?: TokenRefresher;
  env?: NodeJS.ProcessEnv;
  cacheFile?: string;
  now?: () => number;
}

type Cache = Record<string, UsageSnapshot>;

export async function readUsageCache(file: string): Promise<Cache> {
  try {
    const obj: unknown = JSON.parse(await readFile(file, "utf8"));
    return typeof obj === "object" && obj !== null && !Array.isArray(obj) ? (obj as Cache) : {};
  } catch {
    return {};
  }
}

export async function collectUsage(vault: Vault, active: ActiveState, opts: CollectOptions = {}): Promise<AccountUsage[]> {
  const env = opts.env ?? process.env;
  const cacheFile = opts.cacheFile ?? pathsFor(env).usageCacheFile;
  const now = opts.now ?? Date.now;
  const [recs, activeName, cache] = await Promise.all([vault.list(), vault.activeAccount(), readUsageCache(cacheFile)]);

  const results = await Promise.all(
    recs.map(async (rec): Promise<AccountUsage> => {
      const out: AccountUsage = { name: rec.name, email: rec.oauthAccount.emailAddress };
      try {
        const token = await accessTokenFor(vault, active, rec, rec.name === activeName, opts);
        out.usage = await fetchUsage(token, opts.fetchImpl, now);
      } catch (err) {
        out.error = redact(describeError(err));
        const hit = cache[rec.name];
        if (hit) {
          out.usage = hit;
          out.cached = true;
        }
      }
      return out;
    }),
  );

  const live = results.filter((r) => r.usage && !r.cached);
  if (live.length > 0) {
    const next: Cache = { ...cache };
    for (const r of live) next[r.name] = r.usage!;
    try {
      await writeFileAtomic(cacheFile, JSON.stringify(next, null, 2) + "\n", 0o600);
    } catch {
      // the cache is a convenience; a read-only vault must not break usage
    }
  }
  return results;
}

/** A usable access token for the account. The live login wins for the active
 *  account: running Claude Code sessions rotate it without telling the vault. */
async function accessTokenFor(
  vault: Vault,
  active: ActiveState,
  rec: AccountRecord,
  isActive: boolean,
  opts: CollectOptions,
): Promise<string> {
  const now = (opts.now ?? Date.now)();
  if (isActive) {
    try {
      const [live, liveAcc] = await Promise.all([active.readCredential(), active.readOauthAccount()]);
      if (
        live &&
        liveAcc &&
        liveAcc.emailAddress.toLowerCase() === rec.oauthAccount.emailAddress.toLowerCase() &&
        assess(live, now).level === "fresh"
      ) {
        return live.claudeAiOauth.accessToken;
      }
    } catch {
      // unreadable live state: use the vault copy
    }
  }
  if (assess(rec.credential, now).level === "fresh") return rec.credential.claudeAiOauth.accessToken;
  if (!opts.refresh) throw new Error("access token expired (macsub usage refreshes it)");
  const r = await refreshAccount(vault, active, rec.name, opts.client ?? new OAuthClient(opts.fetchImpl), {
    ...(opts.env ? { env: opts.env } : {}),
  });
  if ((r.level === "fresh" || r.level === "refreshed") && r.credential) return r.credential.claudeAiOauth.accessToken;
  throw new Error(`token refresh failed${r.detail ? `: ${r.detail}` : ""}`);
}
