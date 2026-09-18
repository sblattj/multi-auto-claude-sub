import type { ActiveState, Vault } from "../types.js";

export interface ToggleTarget {
  to: string;
  from: string | null;
}

/**
 * Resolve what a bare `macsub swap` means:
 * - exactly two vaulted accounts → the one that is not active (active resolved
 *   from the vault pointer, falling back to matching the LIVE login email)
 * - anything else → throws with a message naming the accounts
 */
export async function resolveToggle(vault: Vault, active: ActiveState): Promise<ToggleTarget> {
  const recs = await vault.list();
  const names = recs.map((r) => r.name);
  if (recs.length !== 2) {
    throw new Error(
      names.length === 0
        ? "vault is empty — `macsub add <name>` first"
        : `bare swap needs exactly two accounts (vaulted: ${names.join(", ")}) — name one: macsub swap <name>`,
    );
  }
  let from = await vault.activeAccount();
  if (from === null) {
    const live = await active.readOauthAccount();
    const match = live ? recs.find((r) => r.oauthAccount.emailAddress === live.emailAddress) : undefined;
    from = match?.name ?? null;
  }
  const to = from === null ? names[0]! : names.find((n) => n !== from)!;
  return { to, from };
}
