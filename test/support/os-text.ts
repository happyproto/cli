// The io::Error text Rust prints for a missing file on this platform: strerror on unix,
// FormatMessage on Windows. The Rust oracles were captured on unix, so their expected text is
// rewritten for Windows with `onThisPlatform`.
const UNIX_ENOENT = "No such file or directory (os error 2)";
const WINDOWS_ENOENT = "The system cannot find the file specified. (os error 2)";

export const ENOENT_TEXT = process.platform === "win32" ? WINDOWS_ENOENT : UNIX_ENOENT;

/** A unix-captured message as Rust would print it here. */
export function onThisPlatform(text: string): string {
  return text.replaceAll(UNIX_ENOENT, ENOENT_TEXT);
}
