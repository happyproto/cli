// etcetera's base strategy, as hpy uses it: XDG on every Unix (macOS included),
// the Known Folders on Windows.
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";

const env = (k: string) => {
  const v = process.env[k];
  return v !== undefined && v !== "" ? v : undefined;
};

/** `$XDG_*` only counts when it is an absolute path, as in etcetera. */
const xdg = (k: string) => {
  const v = env(k);
  return v?.startsWith("/") ? v : undefined;
};

export function configBase(): string {
  if (process.platform === "win32") return env("APPDATA") ?? join(homedir(), "AppData", "Roaming");
  return xdg("XDG_CONFIG_HOME") ?? join(homedir(), ".config");
}

export function cacheBase(): string {
  if (process.platform === "win32")
    return env("LOCALAPPDATA") ?? join(homedir(), "AppData", "Local");
  return xdg("XDG_CACHE_HOME") ?? join(homedir(), ".cache");
}

export function dataBase(): string {
  if (process.platform === "win32") return env("APPDATA") ?? join(homedir(), "AppData", "Roaming");
  return xdg("XDG_DATA_HOME") ?? join(homedir(), ".local", "share");
}

/** `$XDG_CONFIG_HOME/hpy` or `~/.config/hpy` on every Unix, `%APPDATA%\hpy` on Windows. */
export function configDir(): string {
  return join(configBase(), "hpy");
}

/**
 * `Path::join` as Rust does it: an absolute `p` replaces `base`, nothing is
 * normalized, and one separator is added unless `base` already ends in one.
 * Messages print paths the Rust way, so `..` stays where the user wrote it.
 */
export function rustJoin(base: string, ...parts: string[]): string {
  let out = base;
  for (const p of parts) {
    if (isAbsolute(p)) out = p;
    else if (out === "" || out.endsWith(sep) || out.endsWith("/")) out += p;
    else out += sep + p;
  }
  return out;
}
