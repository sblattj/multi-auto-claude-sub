/** "300ms", "4s", "5m", "2h"; a bare number means seconds. */
export function parseDuration(s: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/.exec(s);
  if (!m) throw new Error(`bad duration "${s}" (examples: 4s, 5m, 300ms)`);
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  const scale = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(n * scale);
}

/**
 * Browser-login deadline: explicit flag, else $MACSUB_LOGIN_TIMEOUT, else the
 * default. A bad env value is reported via onBad and ignored (it must not break
 * swaps); a bad flag throws so the CLI can reject it.
 */
export function resolveLoginTimeoutMs(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  fallbackMs: number,
  onBad: (msg: string) => void = () => {},
): number {
  if (flag !== undefined) {
    const ms = parseDuration(flag);
    if (ms <= 0) throw new Error(`bad duration "${flag}": must be greater than zero`);
    return ms;
  }
  const raw = env.MACSUB_LOGIN_TIMEOUT;
  if (raw !== undefined && raw.trim() !== "") {
    try {
      const ms = parseDuration(raw);
      if (ms > 0) return ms;
    } catch {
      /* reported below */
    }
    onBad(`ignoring MACSUB_LOGIN_TIMEOUT="${raw}" (examples: 5m, 600s)`);
  }
  return fallbackMs;
}
