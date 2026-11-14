// Whether a command left work running when it returned: a download a Ctrl-C abandoned in
// `hv dev --network local`. Rust's process ends when `main` returns whatever is still in
// flight; Node's waits for it. So main ends the process itself, but only then: under Bun,
// `process.exit` drops output still queued for a pipe, which a natural exit writes out.

let abandoned = false;

/** Records that a command is returning while work it started is still running. */
export function abandonWork(): void {
  abandoned = true;
}

export function workWasAbandoned(): boolean {
  return abandoned;
}
