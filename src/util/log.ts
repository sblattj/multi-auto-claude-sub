/** Logging + secrets hygiene. Never pass raw tokens through these without redact(). */

const TOKEN_RE = /sk-ant-[A-Za-z0-9_\-]+/g;

export function redact(s: string): string {
  return s.replace(TOKEN_RE, "sk-ant-***");
}

function line(prefix: string, msg: string): void {
  for (const l of redact(msg).split("\n")) {
    // eslint-disable-next-line no-console
    console.log(`${prefix} ${l}`);
  }
}

export const log = {
  info: (msg: string) => line("   ", msg),
  step: (msg: string) => line(" → ", msg),
  warn: (msg: string) => line(" ⚠ ", msg),
  err: (msg: string) => line(" ✗ ", msg),
};
