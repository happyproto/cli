// Loaded with `node --import` into every hpy the tests spawn from dist/hpy.mjs: it resolves
// `@napi-rs/keyring` to keyring-fake.mjs, so a spawned hpy never reaches the OS keychain, even
// on a path that reads it whatever HPY_CREDENTIAL_STORE says (a credentials.json whose key is
// `{"keychain": true}`). The CLI itself has no switch for this.
import { registerHooks } from "node:module";

const FAKE = new URL("./keyring-fake.mjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@napi-rs/keyring") return { url: FAKE, shortCircuit: true };
    return next(specifier, context);
  },
});
