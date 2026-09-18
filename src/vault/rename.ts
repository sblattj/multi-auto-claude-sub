import type { Vault } from "../types.js";

/** Rename a vaulted account: file, name field, and active pointer all follow. */
export async function renameAccount(vault: Vault, from: string, to: string): Promise<void> {
  if (from === to) throw new Error(`macsub: account is already named "${from}"`);
  const rec = await vault.get(from);
  if (rec === null) throw new Error(`macsub: unknown account "${from}"`);
  const existing = await vault.get(to);
  if (existing !== null) throw new Error(`macsub: account "${to}" already exists`);
  const wasActive = (await vault.activeAccount()) === from;
  await vault.remove(from);
  await vault.save({ ...rec, name: to });
  if (wasActive) await vault.setActive(to);
}
