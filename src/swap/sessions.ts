/** Live-session detection (SPEC §4 step 1): warn, never kill. */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathsFor } from "../paths.js";

export interface SessionScanOptions {
  env?: NodeJS.ProcessEnv;
  sessionsDir?: string;
  ideDir?: string;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = exists but not ours to signal → still alive
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Scan <configHome>/sessions/<pid>.json (alive pid?) and
 *  <configHome>/ide/<port>.lock; return warning strings. Never kills anything. */
export async function detectLiveSessions(opts: SessionScanOptions = {}): Promise<string[]> {
  const p = pathsFor(opts.env ?? process.env);
  const sessionsDir = opts.sessionsDir ?? p.sessionsDir;
  const ideDir = opts.ideDir ?? p.ideDir;
  const warnings: string[] = [];

  try {
    for (const f of await readdir(sessionsDir)) {
      const m = /^(\d+)\.json$/.exec(f);
      const pid = m ? Number(m[1]) : NaN;
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (isPidAlive(pid)) {
        warnings.push(
          `live Claude Code session (pid ${pid}) may hold the outgoing account in memory; it is never killed — restart it to pick up the swap`,
        );
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      warnings.push(`session scan failed in ${sessionsDir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  try {
    for (const f of await readdir(ideDir)) {
      const m = /^(\d+)\.lock$/.exec(f);
      const port = m ? Number(m[1]) : NaN;
      if (!Number.isInteger(port) || port <= 0) continue;
      warnings.push(`Claude Code IDE lock present on port ${port} (${join(ideDir, f)}) — an IDE session may be active`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      warnings.push(`IDE lock scan failed in ${ideDir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return warnings;
}
