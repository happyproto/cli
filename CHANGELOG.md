# [1.0.0-alpha.33](https://github.com/happyproto/cli/compare/v1.0.0-alpha.32...v1.0.0-alpha.33) (2026-11-14)


### Bug Fixes

* end hpy when its command returns, and fail a download that stalls ([d74dcf5](https://github.com/happyproto/cli/commit/d74dcf5efec5394a73e88d8e1a552d3792296ee9))
* escape characters by Rust's Unicode tables, not the engine's ([dd33127](https://github.com/happyproto/cli/commit/dd331278265e49924537b4d6baa01aabe2738d3f))
* escape text on the login callback page ([5a0066a](https://github.com/happyproto/cli/commit/5a0066a2b79a871b83ce6a45573505d9b2dda12b))
* exit quietly when the reader of stdout or stderr has gone ([1b1302c](https://github.com/happyproto/cli/commit/1b1302c7f026c16875307868c6d6070b4ab08b27))
* fall back to the credentials file on keyring-core's no-keychain errors ([5da3334](https://github.com/happyproto/cli/commit/5da3334cd600c27f9a310915d3ffd39106ba7a73))
* hand children blocking stdout and stderr, as Rust does ([9ba4b35](https://github.com/happyproto/cli/commit/9ba4b35d445b31af355c144001ac8ab3b0deeda0))
* hand HappyView a blocking stdin ([3194c95](https://github.com/happyproto/cli/commit/3194c95995d4112cd6edacd8df31f67e311937cf))
* honour HTTP_PROXY, HTTPS_PROXY, ALL_PROXY and NO_PROXY as reqwest does ([507ce8a](https://github.com/happyproto/cli/commit/507ce8a82a09c29f81202c2de5e9e6ce945813be))
* keep -C's directory as given, as clap does ([f68aba8](https://github.com/happyproto/cli/commit/f68aba8f6a211e94ac9babf8241ff937b1c2c3d0))
* keep the DPoP key and access token out of printed credentials ([93cb780](https://github.com/happyproto/cli/commit/93cb78059811e5a5cdadd5a2012ab05a556802d2))
* let the installer give glibc 2.31 systems the gnu build ([f7fd4aa](https://github.com/happyproto/cli/commit/f7fd4aac27a3cebf937f46e7b8b0ec28ead6a5e8))
* make the shell installer refuse the musl build where it cannot start ([5893a17](https://github.com/happyproto/cli/commit/5893a17dc8c8c265b916800b69a924fc522cc3a4))
* name every option given in clap's conflict usage line ([26d7844](https://github.com/happyproto/cli/commit/26d78447fbebdded383aa3a30d227e4119081ba2))
* parse the command line with a port of clap's parser ([ee10d2e](https://github.com/happyproto/cli/commit/ee10d2e0d5b42ba9f1629fdc731bbf62b9f5f12b))
* raise the Node floor to what @napi-rs/lzma supports, and check out LF on Windows ([03b39b1](https://github.com/happyproto/cli/commit/03b39b1da7056717d59f593903ad2d01417568a2))
* read HappyView, registry and OAuth answers as serde_json does ([d0e8c7f](https://github.com/happyproto/cli/commit/d0e8c7fa52d3cd9fb76d0df9ca52be3b44e93bf6))
* read HPY_CREDENTIAL and credentials.json as serde and base64 do ([ffd32bd](https://github.com/happyproto/cli/commit/ffd32bd0c78f33cf6696b693084efe352759a5ee))
* refuse to self-update to the musl build where libstdc++ is missing ([66f645e](https://github.com/happyproto/cli/commit/66f645e8fea90c0f54f7167c87d397848bb1b08c))
* remove PLUGIN_DIR from HappyView's environment whatever its case on Windows ([ba160ee](https://github.com/happyproto/cli/commit/ba160ee6f4a5c138c56ed0d7ef9b56b89386fbc4))
* report a HappyView that cannot be exec'd instead of aborting ([f488d06](https://github.com/happyproto/cli/commit/f488d063d5daa5fae46b33687c8be3a0dbe51ef6))
* report a sign-in callback that fails early instead of crashing ([de64a29](https://github.com/happyproto/cli/commit/de64a292d3d942583806cfd8a0c6c8e82ce0624c))
* report credential and sign-in write failures as Rust does ([62a16fb](https://github.com/happyproto/cli/commit/62a16fbd3b66315991881b7bd7ee9310b1324c8b))
* run and pass the test suite on Windows ([a0591fa](https://github.com/happyproto/cli/commit/a0591faa8d5fa126bc4257452dad380cee91cf5c))
* say when a download stopped because it timed out ([fae38a8](https://github.com/happyproto/cli/commit/fae38a8de8f97761c6af3e69f81dec5a9bf43484))
* send empty DPoP nonces and login hints, and keep the last callback value ([0e52c32](https://github.com/happyproto/cli/commit/0e52c3295b40b16454f352d921c005a3b490e24b))
* size help and error reports by the terminal clap and miette find ([c2a21b2](https://github.com/happyproto/cli/commit/c2a21b2bbc25443d753defcff462bf97d9cef9af))
* start the npm bin as node -- so a --env-file argument stays hpy's ([3b23610](https://github.com/happyproto/cli/commit/3b2361026c153234628b8115b54a355074368f7f))
* start the npm bin with plain env node, which BusyBox can run ([34ec6a8](https://github.com/happyproto/cli/commit/34ec6a822c937a42fed2084f961f608a170cf794))
* stop reading a test-only keychain variable in the CLI ([cc2cdfb](https://github.com/happyproto/cli/commit/cc2cdfb3e91705f0c5e0bda4e84a0e86bd546c4d))
* use reqwest's proxy settings under Bun too ([c598070](https://github.com/happyproto/cli/commit/c598070fd49357295a7883ba08ef11a6652fc58f))
* wrap reports at Unicode line-break opportunities, as miette does ([637491b](https://github.com/happyproto/cli/commit/637491bd2162042501d9b6a5e36141df9ad1b25d)), closes [#14](https://github.com/happyproto/cli/issues/14)
* write out all of a large output to a slow pipe under Bun ([8eb671d](https://github.com/happyproto/cli/commit/8eb671deaed86840b5f09b4b625edaa3b2997999))


### Features

* add serde-json fromSlice for serde_json::from_slice ([98c783a](https://github.com/happyproto/cli/commit/98c783abfcd9c9aa0b1ddb52f55765678c1606ea))
* add std::path and create_dir_all helpers for ported file code ([5341152](https://github.com/happyproto/cli/commit/534115214d2517fb28e77480ca98b14965fa7a34))
* let a request go without a timeout, as a reqwest client with none does ([4a7c278](https://github.com/happyproto/cli/commit/4a7c27865e0af4b4f21e48cb38e4d3feacc04907))
* parse and edit TOML as the toml and toml_edit crates do ([2055811](https://github.com/happyproto/cli/commit/20558114170bdd5cc239e74fa408ba57548a61b3))
* parse JSON with serde_json's error messages and positions ([3bdf9e8](https://github.com/happyproto/cli/commit/3bdf9e80f9e0b20430334e4a3587c81790250e90))
* port hpy update, hpy channel and the daily update check ([7a4f5c6](https://github.com/happyproto/cli/commit/7a4f5c66a8561353e824bbfe348547d89cfcaaa9))
* port hpy-plugin's artifact and wasm locating rules ([8cb1e4b](https://github.com/happyproto/cli/commit/8cb1e4ba93602db94d806f24cc28b179038a5f49))
* port hpy-plugin's hpy.toml config ([05576b7](https://github.com/happyproto/cli/commit/05576b7697105f80b5517b2d332a222eb1982099))
* port hpy-plugin's manifest, validation, checksum and changelog rules ([be856a7](https://github.com/happyproto/cli/commit/be856a7a275b45e065ffa86bae6049848cdd59d2))
* port hpy-plugin's project details, authors and contacts ([d28faa7](https://github.com/happyproto/cli/commit/d28faa78d4e91868c5c4464e1b52c6c8138eccd1))
* port hpy-project config.rs and lock.rs ([42da47b](https://github.com/happyproto/cli/commit/42da47bcb90ddae42fcd4551daf484c3e79cce34))
* port hpy-project manifest.rs, place.rs, handlers.rs and scaffold.rs ([fb9b009](https://github.com/happyproto/cli/commit/fb9b009ca4cf1e34ad7afe74d53fc4e9b05729a5))
* port hv add (install) and hv scaffold ([65c96b2](https://github.com/happyproto/cli/commit/65c96b2dfafee146ce41a08bc504d7956699a7f3))
* port hv check, test, types, build and dev, with run.rs's execve and supervised runs ([97785e7](https://github.com/happyproto/cli/commit/97785e7b0c8d1809fda628983d49551621b616ee))
* port hv create, resolving the lock before writing anything ([dcfcbdf](https://github.com/happyproto/cli/commit/dcfcbdf0c41034d71066db4f29bdf7b384fc92ba))
* port hv env push, script variables and the deploy plan and command ([54dc592](https://github.com/happyproto/cli/commit/54dc592b9eebfef6377874a755dedabf33e6c349))
* port hv login, logout and whoami, and the instance admin API, to TypeScript ([795d714](https://github.com/happyproto/cli/commit/795d71415c041a4db1c88902d3a82aa49548fd9e))
* port hv pull, v3 and --legacy, with --diff and --dry-run ([92933c8](https://github.com/happyproto/cli/commit/92933c8669c46b95336157157eccd6cb0a075632))
* port miniz_oxide deflate, flate2 gzip and the tar writer ([05f241c](https://github.com/happyproto/cli/commit/05f241c99e342f74d03fc705e5b64553ab8710da))
* port project/plugins.rs ([c62b4e0](https://github.com/happyproto/cli/commit/c62b4e087f80cdd3c2bbbebab4d86a18dd19a3f7))
* port project/prepare.rs ([64e05a3](https://github.com/happyproto/cli/commit/64e05a33bb9335572dd78667a9f4e14fd537c617))
* port project/resolve.rs ([cc6a600](https://github.com/happyproto/cli/commit/cc6a600fc36d4988e0b54128c2a4acfaed1aac9e))
* port registry login, logout and whoami to TypeScript ([239e220](https://github.com/happyproto/cli/commit/239e22090f43ff0eb09c8e480428afe39af18350))
* port registry plugin init, show, edit, pull and publish ([254f860](https://github.com/happyproto/cli/commit/254f860f713eab7994d74ccfc07b848b611042b4))
* port registry plugin status and lifecycle ([b8ed311](https://github.com/happyproto/cli/commit/b8ed311c60d7b18a1a302b17b18a1e5fb242ecd6))
* port script module builds and the module watcher ([b6accc2](https://github.com/happyproto/cli/commit/b6accc273193c0045ae69f54875af68ba2f9fea8))
* port similar 3.2.1's unified line diff for hv pull --diff ([2300276](https://github.com/happyproto/cli/commit/2300276b000bc157f7d4e59cc5624812f2153e95))
* port the command tree and hpy's core contracts to TypeScript ([2b0daaf](https://github.com/happyproto/cli/commit/2b0daaf707398f8b73a2d02f68ddd0e968212278))
* port the deploy bundle ([6c54a83](https://github.com/happyproto/cli/commit/6c54a8391aaaebccb8013056a6fb48c8447be495))
* port the editor settings hpy writes for a project's languages ([dc27594](https://github.com/happyproto/cli/commit/dc275949a3a8dd7cb8c586ea167349c268c106bf))
* port the local network: Atmosphere in a Box, its sandbox and HappyView in it ([dbb9f89](https://github.com/happyproto/cli/commit/dbb9f89b7af03ec0e437201ff2598920b9afee60))
* port the PDS repo reads the registry commands use ([fcc581e](https://github.com/happyproto/cli/commit/fcc581ee9d8c73fddd47b37b9a3b5c7c4b8485dc))
* port the project cache and the HappyView binary download ([b99de9b](https://github.com/happyproto/cli/commit/b99de9bd47f56dc083391984140168e74cbfa972))
* port the registry client and the session ([5277856](https://github.com/happyproto/cli/commit/52778561fad81ef8bb96a346f614bd9881c340aa))
* port the semver crate's versions and ranges to TypeScript ([5f1ddc2](https://github.com/happyproto/cli/commit/5f1ddc2207ac524d57f4ace6c80e350deda1b758))
* port the UTC clock the update check uses ([013ff6d](https://github.com/happyproto/cli/commit/013ff6dbeeee7eaba48559dc4de9fe98d17e58c6))
* print clap's help and usage lines from the TypeScript hpy ([4294008](https://github.com/happyproto/cli/commit/429400829393392b40e54523935c0e4d8c3d299f))
* read admin answers as serde_json values, with serde's error text ([1d9a3ff](https://github.com/happyproto/cli/commit/1d9a3ff79f5b1a486941b75624bee10df15bb6df))
* read image types and sizes as the imagesize crate does ([98d6f06](https://github.com/happyproto/cli/commit/98d6f0676b5767d592ab0dc9fd7edd168d86bc57))
* resolve a plugin's project name as profile.rs does ([f1babf6](https://github.com/happyproto/cli/commit/f1babf69a3f18c40a38451768158a85f9fe53090))
* route hv dev --network local, with its binary tests ([dd1e5d0](https://github.com/happyproto/cli/commit/dd1e5d05f96625397b43a36834b5cc91fb0af728))

# [1.0.0-alpha.32](https://github.com/happyproto/cli/compare/v1.0.0-alpha.31...v1.0.0-alpha.32) (2026-11-13)


### Bug Fixes

* **pull:** map v2 plugins to the official beta channel ([ff0e373](https://github.com/happyproto/cli/commit/ff0e373ce9167e68409dd029c7179c4580ff48e9))

# [1.0.0-alpha.31](https://github.com/happyproto/cli/compare/v1.0.0-alpha.30...v1.0.0-alpha.31) (2026-11-05)


### Bug Fixes

* **installer:** never offer the copy just installed for removal, and ignore test-only variables in the published scripts ([f879c43](https://github.com/happyproto/cli/commit/f879c4394604ebc130cdff47addb115b4ef09ffa))


### Features

* **installer:** install hpy into /usr/local/bin, with sudo for the copy alone ([4ea0c07](https://github.com/happyproto/cli/commit/4ea0c079db969dc7af6bffd309c1c0a5794c45d6))
* **update:** replace a root-owned copy of hpy with sudo, for the copy alone ([e18bf0b](https://github.com/happyproto/cli/commit/e18bf0b34620a1660d2cbfba0cb734b42cdaeab3))

# [1.0.0-alpha.30](https://github.com/happyproto/cli/compare/v1.0.0-alpha.29...v1.0.0-alpha.30) (2026-11-04)


### Bug Fixes

* **pull:** name the last deploy instead of calling a regenerated project different ([de39940](https://github.com/happyproto/cli/commit/de399403ebca0ca6cd494db1cb74a6a159821f7c))
* **pull:** write only plain project paths ([4ec6786](https://github.com/happyproto/cli/commit/4ec6786499c245282e6355ead00f895f67370ff8))


### Features

* add hpy happyview pull, to build a project from an instance ([5d91266](https://github.com/happyproto/cli/commit/5d9126612f15149f2b61b1ca9ba5983a9b36d3c8))
* **pull:** write interpreter modules from GET /admin/scripts/modules ([0800d76](https://github.com/happyproto/cli/commit/0800d76e171d92e89eeb804ae11ec28a461a64ee))

# [1.0.0-alpha.29](https://github.com/happyproto/cli/compare/v1.0.0-alpha.28...v1.0.0-alpha.29) (2026-11-04)


### Features

* add hpy hv env push, sending .env keys to the instance's script variables ([1239348](https://github.com/happyproto/cli/commit/1239348d536da5711a6cf271f5e5b6548b20c04c))

# [1.0.0-alpha.28](https://github.com/happyproto/cli/compare/v1.0.0-alpha.27...v1.0.0-alpha.28) (2026-11-02)


### Features

* say an instance's limit in its host's words ([b377aa6](https://github.com/happyproto/cli/commit/b377aa67488ac0f79d7c93a839ce44ab85eae2ad))

# [1.0.0-alpha.27](https://github.com/happyproto/cli/compare/v1.0.0-alpha.26...v1.0.0-alpha.27) (2026-11-02)


### Bug Fixes

* **scaffold:** import Params whenever the lexicon has a parameters block, as HappyView exports it ([3f44ad3](https://github.com/happyproto/cli/commit/3f44ad309c4dd2aaa9669b2c34d1b1cee5594be0))
* **scaffold:** show project paths with / on every platform ([59e4d72](https://github.com/happyproto/cli/commit/59e4d724c6766a3160798b3a430084a7805d61b2))


### Features

* add hpy happyview scaffold, and have check point at it ([f3fce2b](https://github.com/happyproto/cli/commit/f3fce2b69771b5ec95d9eb01a31b4a45aa2f44eb))

# [1.0.0-alpha.26](https://github.com/happyproto/cli/compare/v1.0.0-alpha.25...v1.0.0-alpha.26) (2026-11-02)


### Bug Fixes

* rename a copied plugin into place, so a running dev never sees half of one ([f45a07e](https://github.com/happyproto/cli/commit/f45a07e01921814fcb82a98c60c0d3fcf7dc0afe))


### Features

* place added plugins where dev already has, so it can load them live ([c562503](https://github.com/happyproto/cli/commit/c56250322d5cc2df5e99cf4904ee3d8d09d5de8d))

# [1.0.0-alpha.25](https://github.com/happyproto/cli/compare/v1.0.0-alpha.24...v1.0.0-alpha.25) (2026-11-02)


### Bug Fixes

* stop sending the client key on registry reads ([df50313](https://github.com/happyproto/cli/commit/df50313b96630849170747261b7ec48e1e7437d7))

# [1.0.0-alpha.24](https://github.com/happyproto/cli/compare/v1.0.0-alpha.23...v1.0.0-alpha.24) (2026-11-02)


### Bug Fixes

* show the superadmin's handle beside its DID in hv create ([53a959e](https://github.com/happyproto/cli/commit/53a959e254ea73383cb2eb28b9656059a9b8dd45))

# [1.0.0-alpha.23](https://github.com/happyproto/cli/compare/v1.0.0-alpha.22...v1.0.0-alpha.23) (2026-11-01)


### Bug Fixes

* treat a lexicon refusal as the publisher's to fix ([9d75fa1](https://github.com/happyproto/cli/commit/9d75fa137cb670e43de16a77b5b5c0f6804a18a8))

# [1.0.0-alpha.22](https://github.com/happyproto/cli/compare/v1.0.0-alpha.21...v1.0.0-alpha.22) (2026-10-31)


### Bug Fixes

* let Windows PowerShell 5.1 filter the releases one at a time ([cf0ebfe](https://github.com/happyproto/cli/commit/cf0ebfefe1a5102fe08a01391bec6a61b1db0d6c))
* publish a PowerShell installer per release channel ([ea7441b](https://github.com/happyproto/cli/commit/ea7441b87995383f6e683d4bf68fc7222fbe60e0))

# [1.0.0-alpha.21](https://github.com/happyproto/cli/compare/v1.0.0-alpha.20...v1.0.0-alpha.21) (2026-10-31)


### Bug Fixes

* rewrite a lock that records no plugin capabilities ([a092e0e](https://github.com/happyproto/cli/commit/a092e0e4426c37754ac889f443481af2c56d4765))


### Features

* accept each plugin's locked capabilities when deploying ([c80f5c2](https://github.com/happyproto/cli/commit/c80f5c2e5661c8775c3c83c93dc924db55b9e16f))

# [1.0.0-alpha.20](https://github.com/happyproto/cli/compare/v1.0.0-alpha.19...v1.0.0-alpha.20) (2026-10-30)


### Bug Fixes

* refuse to run HappyView locally on Windows, which it no longer ships for ([287b0db](https://github.com/happyproto/cli/commit/287b0db8e6672571ad997e936f96c0b06ab144f1))

# [1.0.0-alpha.19](https://github.com/happyproto/cli/compare/v1.0.0-alpha.18...v1.0.0-alpha.19) (2026-10-29)


### Bug Fixes

* sign in to an instance through the redirect relay ([decfcca](https://github.com/happyproto/cli/commit/decfcca9e5a99f5186d207288d3c06175e5a6d13))

# [1.0.0-alpha.18](https://github.com/happyproto/cli/compare/v1.0.0-alpha.17...v1.0.0-alpha.18) (2026-10-29)


### Bug Fixes

* read the admin grant as happyview does, and word refusals for the sign-in used ([3a52706](https://github.com/happyproto/cli/commit/3a527061f77e204caa37ef807d7f630f756b73ac))


### Features

* ask for happyview's admin permission set when signing in to an instance ([e578aaa](https://github.com/happyproto/cli/commit/e578aaa0ce8a581a2ae0b764874d92f946721996))
* deploy the project's lexicons, scripts and modules to an instance ([d0c91e9](https://github.com/happyproto/cli/commit/d0c91e93081020705030ade9dc5c45b5c7c5b358))
* say to sign in again when an instance sign-in lacks the admin grant ([e44b93c](https://github.com/happyproto/cli/commit/e44b93c4aead41def8e4a16315ae41fc912850f1))
* show where in a file the instance found each project problem ([388c97a](https://github.com/happyproto/cli/commit/388c97af64f2c8b4151f7ba8c7b688aafcd0e2c2))
* sign in to a happyview instance and deploy its plugins ([5ae331d](https://github.com/happyproto/cli/commit/5ae331d1876fe242e4c2bfd3bb49034f9e32242a))
* sign in to an instance through the browser and keep api keys for ci ([2d6120f](https://github.com/happyproto/cli/commit/2d6120f41fc1a8c6ddd267f5a96ae2c30107d4f3))

# [1.0.0-alpha.17](https://github.com/happyproto/cli/compare/v1.0.0-alpha.16...v1.0.0-alpha.17) (2026-10-27)


### Features

* pass --json through to happyview check ([58ae52e](https://github.com/happyproto/cli/commit/58ae52e58329fb69a41c65d7a1fc4ae47ca9e232))
* point editors at the types happyview writes ([650e39b](https://github.com/happyproto/cli/commit/650e39ba737dcd44502d8e043db7589b8eb822f9))

# [1.0.0-alpha.16](https://github.com/happyproto/cli/compare/v1.0.0-alpha.15...v1.0.0-alpha.16) (2026-10-27)


### Bug Fixes

* key software.release version and channel records with a dot ([67e3edb](https://github.com/happyproto/cli/commit/67e3edb8e324a74c5585ce9fec98c1bf745f957c))

# [1.0.0-alpha.15](https://github.com/happyproto/cli/compare/v1.0.0-alpha.14...v1.0.0-alpha.15) (2026-10-26)


### Bug Fixes

* accept a resumed publish without a manifest and tidy what hpy sends ([aa32ce0](https://github.com/happyproto/cli/commit/aa32ce022cd5f1e73d83721bf91d887d3492a95b))
* **deps:** update webpage and triage the advisory in crypto-bigint 0.5 ([1b8e77c](https://github.com/happyproto/cli/commit/1b8e77cbaf610fc425488597fdcfdae6d66dd983))
* keep project details, icons and pins in step with the registry ([8a645c8](https://github.com/happyproto/cli/commit/8a645c8d34618e8fa8295d5bf4b6d23ac7adc9fa))
* only write back a project edit to the hpy.toml it belongs to ([02bd585](https://github.com/happyproto/cli/commit/02bd58540dd2fcb37568f1fa53bcb1cfc1026e5c))
* refuse publication names and changelog headings the registry would reject ([ab3c35c](https://github.com/happyproto/cli/commit/ab3c35c8af2848c4b0963ec1f826dca695f9dfe5))


### Features

* describe plugins as software.release projects and artifacts ([aadffe2](https://github.com/happyproto/cli/commit/aadffe2c633ed20aaa30d5ae7b28385a52cbf3ed))
* lock and install plugins from the software.release registry ([87ea2a5](https://github.com/happyproto/cli/commit/87ea2a5fad19be7c9278c8d1b14bca193759e8d8))
* publish plugins through the software.release registry ([4b2727c](https://github.com/happyproto/cli/commit/4b2727c0d9a401fc25abfd765b9c86b0f164fa18))
* speak the software.release registry api ([9efc899](https://github.com/happyproto/cli/commit/9efc89924cc1ee7fda8c1e9c2fb2722ab4b3b4ba))

# [1.0.0-alpha.14](https://github.com/happyproto/cli/compare/v1.0.0-alpha.13...v1.0.0-alpha.14) (2026-10-23)


### Bug Fixes

* parse --subnet where windows builds can see it ([ef6eedb](https://github.com/happyproto/cli/commit/ef6eedbc411da094f1eae3d9789397afb29fe452))


### Features

* let a project choose its local network's subnet ([340c759](https://github.com/happyproto/cli/commit/340c7599515910ab62bdef495ef47afce87c28f7))

# [1.0.0-alpha.13](https://github.com/happyproto/cli/compare/v1.0.0-alpha.12...v1.0.0-alpha.13) (2026-10-23)


### Bug Fixes

* update ctutils past RUSTSEC-2026-0385 ([8d8d683](https://github.com/happyproto/cli/commit/8d8d6831a08d836eeebe7a7b3d780af2ebedac3c))

# [1.0.0-alpha.12](https://github.com/happyproto/cli/compare/v1.0.0-alpha.11...v1.0.0-alpha.12) (2026-10-23)


### Bug Fixes

* take the zip and rustls releases that fix their advisories ([9518a57](https://github.com/happyproto/cli/commit/9518a57259803397fa612d37284688372a92e098))

# [1.0.0-alpha.11](https://github.com/happyproto/cli/compare/v1.0.0-alpha.10...v1.0.0-alpha.11) (2026-10-20)


### Bug Fixes

* keep an interpreter's library list from its published manifest ([c458e53](https://github.com/happyproto/cli/commit/c458e53b1b560cb4ab12de5db94a7224db51887d))

# [1.0.0-alpha.10](https://github.com/happyproto/cli/compare/v1.0.0-alpha.9...v1.0.0-alpha.10) (2026-10-16)


### Features

* publish a shell installer per release channel ([effcf3d](https://github.com/happyproto/cli/commit/effcf3d11f3e14f3428c64fe4baad875f6072bbe))

# [1.0.0-alpha.9](https://github.com/happyproto/cli/compare/v1.0.0-alpha.8...v1.0.0-alpha.9) (2026-10-16)


### Bug Fixes

* update a cargo-installed hpy in place instead of asking for a build ([a5dcb06](https://github.com/happyproto/cli/commit/a5dcb06f2950f7b751aa9216f4dccbdb7a5d0196))

# [1.0.0-alpha.8](https://github.com/happyproto/cli/compare/v1.0.0-alpha.7...v1.0.0-alpha.8) (2026-10-16)


### Bug Fixes

* ask for the blob scope a manifest upload needs ([1cbc838](https://github.com/happyproto/cli/commit/1cbc838fa9223df8d314153ff4ad245fbe71eec4))

# [1.0.0-alpha.7](https://github.com/happyproto/cli/compare/v1.0.0-alpha.6...v1.0.0-alpha.7) (2026-10-16)


### Bug Fixes

* build the interruptible module loop on unix only ([e3a5558](https://github.com/happyproto/cli/commit/e3a55582af8adea1ee0cd151eeea1bb8354cee4a))
* stop the first module build at ctrl-c under the local network ([0743a09](https://github.com/happyproto/cli/commit/0743a09da53cd5a6b280f0658458513cc5cecdbb))


### Features

* publish a release's manifest.json beside its module ([c46c88e](https://github.com/happyproto/cli/commit/c46c88e13f07ebbff927e427249da793ca4e3323))

# [1.0.0-alpha.6](https://github.com/happyproto/cli/compare/v1.0.0-alpha.5...v1.0.0-alpha.6) (2026-10-15)


### Bug Fixes

* remove the stopped access relay before starting it again ([6479bc1](https://github.com/happyproto/cli/commit/6479bc18874f307b8e150b7a4ea7c1d3b0cb3058))

# [1.0.0-alpha.5](https://github.com/happyproto/cli/compare/v1.0.0-alpha.4...v1.0.0-alpha.5) (2026-10-14)


### Bug Fixes

* build and rebuild script modules under the local network ([9b97bcc](https://github.com/happyproto/cli/commit/9b97bcc0a6efba6c3c1a934670b5bdd2f726d62b))
* build private directories through one helper so windows has no unused mut ([8da243c](https://github.com/happyproto/cli/commit/8da243c91d56c1f48f9045e7b75ad95affd80864))
* compare release checksums by digest ([d676c81](https://github.com/happyproto/cli/commit/d676c8103f255541bbfb07e526ce8ada45d50ade))
* create a project inside an existing empty directory ([751819d](https://github.com/happyproto/cli/commit/751819de0c927d3dc28ce608b65871f69bbcb62a))
* give the registry test doubles retry_release ([35eff46](https://github.com/happyproto/cli/commit/35eff4603c932b90bc48d579b9df732f55161bcc))
* hold script module builds to happyview's rules and stop them cleanly ([cfbb332](https://github.com/happyproto/cli/commit/cfbb332842c6cb3d7ba69717f935f3abd76eb513))
* refuse a cache directory hpy shouldn't trust instead of changing it ([f45944f](https://github.com/happyproto/cli/commit/f45944f181269b6207980c66c2ca9b670ee260b5))
* run the local network's children apart from ctrl-c and match the spike ([c5e2a05](https://github.com/happyproto/cli/commit/c5e2a05d28c75be7622dfb9c98db161f03386a6f))
* take the module watch baseline before the first build ([eb86e52](https://github.com/happyproto/cli/commit/eb86e5299afda6e4584ec2b507daee02a75b5c77))
* write happyview.toml through a symlink and keep its mode ([3a5ad8b](https://github.com/happyproto/cli/commit/3a5ad8b2ccde9ab68f4d399bf31ed46e498dde26))


### Features

* add hpy happyview add ([a3bf1ed](https://github.com/happyproto/cli/commit/a3bf1edde2173455d07dee6546fed19f559085cc))
* add hpy happyview check and test ([56d4240](https://github.com/happyproto/cli/commit/56d4240db6857fd67d4f79801d76b567c31c3c9f))
* add hpy happyview create ([d43c8f1](https://github.com/happyproto/cli/commit/d43c8f19c8cd682f4e333aa7ea58e0dded831928))
* add hpy happyview dev ([5e9f056](https://github.com/happyproto/cli/commit/5e9f0560c38176d58f6b4ce868b3459c6a896da9))
* add hpy happyview dev --network local ([2076279](https://github.com/happyproto/cli/commit/207627960831906a453a26225bc9a6ea31b4c9dc))
* build compiled script modules ([a03f977](https://github.com/happyproto/cli/commit/a03f977c0081bbae505088b08e2d484db1f862cf))
* define happyview.lock ([8eb4a95](https://github.com/happyproto/cli/commit/8eb4a9581745b6d8c3948ddd47e074e8cd5639a1))
* describe happyview as an atmosphere in a box managed application ([3bce48a](https://github.com/happyproto/cli/commit/3bce48ab59f632a6e6f78b846e4d8db50ccb2e56))
* download locked plugins into the cache, verified by checksum ([04edff3](https://github.com/happyproto/cli/commit/04edff39d1b7d0c84d11f93903784e7b5853783c))
* drive the sandbox lifecycle through its cli ([d9fec75](https://github.com/happyproto/cli/commit/d9fec75198ae46d73859576df5ffa3ade8735777))
* fetch the pinned HappyView binary, verified against its release checksum ([7d6cecb](https://github.com/happyproto/cli/commit/7d6cecbff78657c30dc6e086fce34980f410acc4))
* install a pinned atmosphere in a box per project ([d757961](https://github.com/happyproto/cli/commit/d757961ce9d90a171ee484b84e8bec54377e8e72))
* place locked plugins where happyview dev loads them ([710258e](https://github.com/happyproto/cli/commit/710258eb44e099a13bef8b85475e91d119c2baf7))
* publish an interpreter's file extensions in its release ([99dde6a](https://github.com/happyproto/cli/commit/99dde6a01ddb336f51ee5c61df5c45cc9f83bfe4))
* read and edit happyview.toml in hpy-project ([e887304](https://github.com/happyproto/cli/commit/e887304c2350b2b2ed83ecc6d4e1b86117bf2b40))
* read script modules and check their toolchain ([e209a59](https://github.com/happyproto/cli/commit/e209a59cb7739256fc58c028960de3385f87a1aa))
* read the sandbox's seeded superadmin ([fc912ba](https://github.com/happyproto/cli/commit/fc912ba6a6a6b8813207d64e9a0c3048e7ec79fa))
* rebuild a plugin manifest from its registry release ([095efc1](https://github.com/happyproto/cli/commit/095efc1eb72b571265d9b3a99129afa206bec125))
* rebuild script modules on change in dev ([ca6396a](https://github.com/happyproto/cli/commit/ca6396a67a97dd38f4896d92194c30a6064b153e))
* render a starter HappyView project ([95046c8](https://github.com/happyproto/cli/commit/95046c8db70600ad7eb57602c5ac470b84782810))
* resolve happyview.toml into happyview.lock from the registry ([55d1983](https://github.com/happyproto/cli/commit/55d19838066b50910e3cd94747675c3a71d6308c))
* run a child in the foreground with signals and its exit code passed through ([0ce4847](https://github.com/happyproto/cli/commit/0ce484721474af235dcc5ab705002e35e47bf686))
* search the registry by plugin type and download artifacts ([0bb89b8](https://github.com/happyproto/cli/commit/0bb89b8020b8ba748ac33453b1680189e1f5f40e))
* walk through sandbox access without editing hosts or trust ([9807a09](https://github.com/happyproto/cli/commit/9807a09737a0457b66bd702866f947ca11e48101))

# [1.0.0-alpha.4](https://github.com/happyproto/cli/compare/v1.0.0-alpha.3...v1.0.0-alpha.4) (2026-10-13)


### Features

* hpy registry plugin retry ([2714c91](https://github.com/happyproto/cli/commit/2714c918c2974f585386c0db9e6d4f4a1fcb729d))

# [1.0.0-alpha.3](https://github.com/happyproto/cli/compare/v1.0.0-alpha.2...v1.0.0-alpha.3) (2026-10-13)


### Bug Fixes

* resolve --wasm against the plugin's directory ([521f611](https://github.com/happyproto/cli/commit/521f6118b376deb78cf2a716ae9771c0b14d6146))

# [1.0.0-alpha.2](https://github.com/happyproto/cli/compare/v1.0.0-alpha.1...v1.0.0-alpha.2) (2026-10-12)


### Features

* update channels, `hpy update` and `hpy channel` ([e965083](https://github.com/happyproto/cli/commit/e9650830c7259210b040a35cc57113b730c0f53c))

# 1.0.0-alpha.1 (2026-10-11)


### Features

* hpy, the HappyProto command line ([e86aa24](https://github.com/happyproto/cli/commit/e86aa2448d11356821582412dc626228d5749e25))
