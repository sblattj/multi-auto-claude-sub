/** "300ms", "4s", "5m", "2h"; a bare number means seconds. */
export function parseDuration(s: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/.exec(s);
  if (!m) throw new Error(`bad duration "${s}" (examples: 4s, 5m, 300ms)`);
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  const scale = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(n * scale);
}
