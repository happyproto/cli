# Test credentials

Made by the Rust hpy's own exporter (`hpy_atproto::credential::export` and
`credential::save`) for a throwaway P-256 key and a fake access token, so the
TypeScript port can prove it reads what the Rust code wrote. They sign nothing
anywhere: no HappyView or PDS knows the key, and the token is
`spike-fake-token`. The DID is HappyProto's public one, so read-only registry
queries (`plugin show`) find a real public project.

- `HPY_CREDENTIAL`: an exported credential, as `hpy registry login --export` prints it.
- `credentials.file.json`: `credentials.json` with the key inline (`HPY_CREDENTIAL_STORE=file`).
- `credentials.keychain.json`: `credentials.json` whose key is in the OS keychain.
