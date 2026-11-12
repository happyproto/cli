// etcetera's base strategy, as hpy uses it: XDG on every Unix (macOS included),
// the Known Folders on Windows.
import { homedir } from "node:os";
import { join } from "node:path";

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
