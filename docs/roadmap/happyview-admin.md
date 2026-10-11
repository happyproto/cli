# Roadmap: managing HappyView instances

Notes for when `hpy` gains commands for a HappyView instance's admin API.
These are not implemented yet. Today the only sign-in is
`hpy registry login`, which authenticates through happyproto.at's HappyView
instance and is used only to publish plugins to the registry.

## Command shape

- `hpy happyview …`, with `hv` as an alias: `hpy hv` is the same as
  `hpy happyview`.
- Each kind of sign-in sits under the thing it signs in to, never at the top
  level:
  - `hpy registry login`: the plugin registry (exists today).
  - `hpy happyview login --url https://api.example.com`: one HappyView
    instance's admin API.
  - `hpy happyproto login`: HappyProto projects.

These sign-ins hold different information and aren't interchangeable. Signing
in through HappyProto does nothing for a self-hosted HappyView instance.

## Profiles

One person may manage many instances, and may use more than one account on
the same instance. Sign-ins are therefore stored as named profiles:

```sh
hpy hv login --url https://api.trezy.pet --profile trezy-trezy.pet       # trezy.codes on api.trezy.pet
hpy hv login --url https://api.trezy.pet --profile superadmin-trezy.pet  # a superadmin account, same instance
hpy hv login --profile happyproto                                        # the happyproto.at instance
```

- A profile records an instance URL plus the account signed in to it.
- Every command that needs authentication takes `--profile <name>`, e.g.
  `hpy hv whoami --profile happyproto`.
- A default profile is used when `--profile` isn't given. It needs a way to
  set and show the default, e.g. `hpy hv profile use <name>`.
- Open questions:
  - Should the registry sign-in become a profile too, or stay a single
    session?
  - How does a profile name map to the keychain? Today the account name is
    `<registry host>/<did>`.
  - What is the CI equivalent of `HPY_CREDENTIAL` for a profile?
