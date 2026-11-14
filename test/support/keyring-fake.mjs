// A stand-in for @napi-rs/keyring's `Entry` (see keyring-hook.mjs), kept in
// `$HOME/test-keychain.json` so a spawned hpy's items outlive the process. HOME is the test's
// private directory.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const file = () => join(process.env.HOME ?? ".", "test-keychain.json");
const read = () => (existsSync(file()) ? JSON.parse(readFileSync(file(), "utf8")) : {});
const write = (items) => writeFileSync(file(), JSON.stringify(items));

export class Entry {
  #key;

  constructor(service, account) {
    this.#key = `${service}/${account}`;
  }

  getPassword() {
    return read()[this.#key] ?? null;
  }

  setPassword(secret) {
    write({ ...read(), [this.#key]: secret });
  }

  deletePassword() {
    const items = read();
    const had = this.#key in items;
    delete items[this.#key];
    write(items);
    return had;
  }
}
