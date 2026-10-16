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
