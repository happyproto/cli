// Putting the standard streams back into blocking mode before a child inherits them.
//
// Node's libuv sets O_NONBLOCK on stdout and stderr when they are pipes, and Bun does so on
// every stream it touches. That flag belongs to the open file description, which a child
// shares, so a program `hpy` execs or spawns would see its own stdout as non-blocking and fail
// with EAGAIN once a slow reader (`| less`, a CI log) fills the pipe. Rust never sets the flag.
// Node clears it for the children it spawns, but not across `process.execve`; Bun clears it for
// neither.

type Fcntl = (fd: number, cmd: number, arg: number) => number;

const F_GETFL = 3;
const F_SETFL = 4;
const O_NONBLOCK = process.platform === "darwin" ? 0x4 : 0x800;

let fcntl: Fcntl | null | undefined;

/** libc's `fcntl` through bun:ffi, under Bun on unix; null elsewhere or when it cannot load. */
function bunFcntl(): Fcntl | null {
  if (fcntl !== undefined) return fcntl;
  fcntl = null;
  const meta = import.meta as unknown as { require?: (id: string) => unknown };
  if (!("Bun" in globalThis) || process.platform === "win32" || !meta.require) return fcntl;
  try {
    const ffi = meta.require("bun:ffi") as {
      dlopen(path: string, symbols: object): { symbols: { fcntl: Fcntl } };
      FFIType: { i32: unknown };
    };
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    const libs =
      process.platform === "darwin"
        ? ["libc.dylib", "/usr/lib/libSystem.B.dylib"]
        : ["libc.so.6", `/lib/ld-musl-${arch}.so.1`, "libc.so"];
    const i32 = ffi.FFIType.i32;
    for (const lib of libs) {
      try {
        fcntl = ffi.dlopen(lib, { fcntl: { args: [i32, i32, i32], returns: i32 } }).symbols.fcntl;
        break;
      } catch {
        // the next candidate
      }
    }
  } catch {
    fcntl = null;
  }
  return fcntl;
}

/** Clears O_NONBLOCK on fds 0 to 2, so a child that inherits them blocks as it expects. */
export function blockingStdio(): void {
  if (process.platform === "win32") return;
  for (const s of [process.stdout, process.stderr]) {
    const handle = (s as unknown as { _handle?: { setBlocking?: (b: boolean) => unknown } })
      ._handle;
    try {
      handle?.setBlocking?.(true);
    } catch {
      // not a pipe or a terminal
    }
  }
  const f = bunFcntl();
  if (!f) return;
  for (const fd of [0, 1, 2]) {
    const flags = f(fd, F_GETFL, 0);
    if (flags >= 0 && flags & O_NONBLOCK) f(fd, F_SETFL, flags & ~O_NONBLOCK);
  }
}
