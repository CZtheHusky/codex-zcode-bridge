# 更新日志

本文件记录面向用户的变更。版本号遵循语义化版本，并由 Release Please 根据 Conventional Commits 生成发布记录：`fix:` 升补丁号，`feat:` 升次版本号，`BREAKING CHANGE:` 升主版本号。

当前版本以 `package.json` 和 Release Please manifest 为准。提交推送到 `master` 后，Release Please 会在有待发布变更时创建发布 PR，并同步更新版本文件与本日志；合并发布 PR 后会生成对应 Git tag 和 GitHub Release。

## [1.2.6](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.2.5...codex-zcode-bridge-v1.2.6) (2026-10-16)


### Bug Fixes

* preserve browser environment and validate short repository roots ([f3576a2](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f3576a266adb02f2c7e30428f304ccd34f29ea5f))
* preserve browser environment and validate short repository roots ([2bf434d](https://github.com/Sandyzzx/codex-zcode-bridge/commit/2bf434dc09ca8e4ab7e5df9195850647cc53882c))

## [1.2.5](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.2.4...codex-zcode-bridge-v1.2.5) (2026-10-16)


### Bug Fixes

* add optional headless browser host and handle large session payloads ([020c8a9](https://github.com/Sandyzzx/codex-zcode-bridge/commit/020c8a918d47bb5c6f94a2fa1b0a8049aae5c80c))
* stabilize browser timeout fixtures on Node 22 ([34f26e8](https://github.com/Sandyzzx/codex-zcode-bridge/commit/34f26e893fcfffebdbf3f36e36912723e5a71656))
* support headless browser hosting and large session interactions ([66e81b1](https://github.com/Sandyzzx/codex-zcode-bridge/commit/66e81b18577edc36c876faa03908ee4471ca6a89))

## [1.2.4](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.2.3...codex-zcode-bridge-v1.2.4) (2026-10-14)


### Bug Fixes

* stop work and report exhausted ZCode usage ([6756225](https://github.com/Sandyzzx/codex-zcode-bridge/commit/675622515db6475b095ce63b17c860fc8f549c89))

## [1.2.3](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.2.2...codex-zcode-bridge-v1.2.3) (2026-10-08)


### Bug Fixes

* improve bridge reliability for long sessions ([ae8aa66](https://github.com/Sandyzzx/codex-zcode-bridge/commit/ae8aa6692802b3af3426e20741db3719184680e5))

## [1.2.2](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.2.1...codex-zcode-bridge-v1.2.2) (2026-10-07)


### Bug Fixes

* render concise task feedback ([a8af97e](https://github.com/Sandyzzx/codex-zcode-bridge/commit/a8af97ea105e7f15dbeb12b3ca2eb20ad2134d3f))
* render concise task feedback ([842404b](https://github.com/Sandyzzx/codex-zcode-bridge/commit/842404bf6b43c48d15a97a68e0b07f850d0c92d7))

## [1.2.1](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.2.0...codex-zcode-bridge-v1.2.1) (2026-10-06)


### Bug Fixes

* recover terminal cleanup holds safely ([0c2d834](https://github.com/Sandyzzx/codex-zcode-bridge/commit/0c2d834b783e542abb0f1fc282b162c739d63bf5))
* recover terminal cleanup holds safely ([8044fda](https://github.com/Sandyzzx/codex-zcode-bridge/commit/8044fda49616c44c900c2dae954a8ce141167825))
* retry transient Windows lock publication races ([#30](https://github.com/Sandyzzx/codex-zcode-bridge/issues/30)) ([62205f0](https://github.com/Sandyzzx/codex-zcode-bridge/commit/62205f07f6277ff68e30b85d00e81e1431c02a64))

## [1.2.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.1.0...codex-zcode-bridge-v1.2.0) (2026-10-05)


### Features

* add provenance-aware task feedback snapshot ([fcd9b6f](https://github.com/Sandyzzx/codex-zcode-bridge/commit/fcd9b6f9cc8f077d8cae6a21fdc954bf1e67459a))
* add provenance-aware task feedback snapshot ([f1f6b12](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f1f6b12ffe84c42db491e59fb34096a1569489b6))

## [1.1.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.0.5...codex-zcode-bridge-v1.1.0) (2026-10-05)


### Features

* add project task ledger and structured ZCode run reporting ([a814f01](https://github.com/Sandyzzx/codex-zcode-bridge/commit/a814f015921d89c02efdd5021ed8e6dcc86bd98a))
* add task ledger and structured run reporting ([79082a6](https://github.com/Sandyzzx/codex-zcode-bridge/commit/79082a6711441e09b7310fc0c58c6f64fcd342fb))

## [1.0.5](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.0.4...codex-zcode-bridge-v1.0.5) (2026-10-03)


### Bug Fixes

* preserve completed results through cleanup ([3c5b916](https://github.com/Sandyzzx/codex-zcode-bridge/commit/3c5b9168867986fe15894e5723015b3e1e775efe))
* replay missed ZCode session events ([f36b885](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f36b8857e765df06900d289aed44e1f6539a6355))

## [1.0.4](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.0.3...codex-zcode-bridge-v1.0.4) (2026-10-03)


### Bug Fixes

* handle cancellation in active detached workers ([bf23b8b](https://github.com/Sandyzzx/codex-zcode-bridge/commit/bf23b8b97bc8beb3016413da2a322d3d155690aa))
* make task retries idempotent and status reads responsive ([34134b6](https://github.com/Sandyzzx/codex-zcode-bridge/commit/34134b6a20481bbab9786e70ceeb3d50e468819f))
* reconcile verified worker exits during cancellation ([b09a391](https://github.com/Sandyzzx/codex-zcode-bridge/commit/b09a3914d6baa5c56721b6aea77aa8ae0a8cc2a7))

## [1.0.3](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.0.2...codex-zcode-bridge-v1.0.3) (2026-10-02)


### Bug Fixes

* harden task execution and extract shared host core ([3427555](https://github.com/Sandyzzx/codex-zcode-bridge/commit/34275551780df766810d97127a60b45ad4af655c))

## [1.0.2](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.0.1...codex-zcode-bridge-v1.0.2) (2026-10-02)


### Bug Fixes

* **manager:** cold-start grace window and one-shot worker respawn ([db8cab5](https://github.com/Sandyzzx/codex-zcode-bridge/commit/db8cab50e4af1091dd775d23ca0327503a2150bb))

## [1.0.1](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.0.0...codex-zcode-bridge-v1.0.1) (2026-10-01)


### Bug Fixes

* launch Bridge from portable plugin manifest ([6c455ac](https://github.com/Sandyzzx/codex-zcode-bridge/commit/6c455acf1cfeda358462f010afda04623cf7605f))

## [1.0.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v0.10.1...codex-zcode-bridge-v1.0.0) (2026-09-30)


### Bug Fixes

* **ci:** verify committed bridge bundle ([ed4dead](https://github.com/Sandyzzx/codex-zcode-bridge/commit/ed4deadf7719682fcc534ce38d003ef4c1619143))
* **plugin:** avoid false shell injection finding ([909a428](https://github.com/Sandyzzx/codex-zcode-bridge/commit/909a4285fce9df26816c8071abf9b95d274fe379))

## [0.10.1](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v0.10.0...codex-zcode-bridge-v0.10.1) (2026-09-30)


### Bug Fixes

* **plugin:** prepare scanner-ready marketplace bundle ([26d18ff](https://github.com/Sandyzzx/codex-zcode-bridge/commit/26d18ffa8e7ec528693eb1830332acb46c33aeb0))

## [0.10.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v0.9.0...codex-zcode-bridge-v0.10.0) (2026-09-30)


### Features

* configure marketplace plugin icons ([b0fbf0b](https://github.com/Sandyzzx/codex-zcode-bridge/commit/b0fbf0b80181c8adbead69c57b596025b21156bf))

## [0.9.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v0.8.0...codex-zcode-bridge-v0.9.0) (2026-09-30)


### Features

* report active reasoning level at task startup ([2697c58](https://github.com/Sandyzzx/codex-zcode-bridge/commit/2697c582c7c86bf1eaf25a14c1a0f27345cf9374))

## [0.8.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v0.7.2...codex-zcode-bridge-v0.8.0) (2026-09-30)


### Features

* add model catalog controls and refresh plugin branding ([9ac27e2](https://github.com/Sandyzzx/codex-zcode-bridge/commit/9ac27e2b654bd6cc11dd99981e134ae9671d838f))

## [0.7.2](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v0.7.1...codex-zcode-bridge-v0.7.2) (2026-09-29)


### Bug Fixes

* update codex plugin manifest on release ([f2af48c](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f2af48c3b425376fd3d66490b06ab34190c07c7e))

## [0.7.1](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v0.7.0...codex-zcode-bridge-v0.7.1) (2026-09-29)


### Bug Fixes

* avoid double-prefixing account provider IDs ([6175e45](https://github.com/Sandyzzx/codex-zcode-bridge/commit/6175e45f2c8dc9825d08d109517cf23aa6f59f15))

## [0.7.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v0.6.0...codex-zcode-bridge-v0.7.0) (2026-09-29)


### Features

* add setup diagnostics and task reliability coverage ([fbcf756](https://github.com/Sandyzzx/codex-zcode-bridge/commit/fbcf75663811e2a59aabdb49b6feaf224b3d8448))
* add setup diagnostics and task reliability coverage ([14a8654](https://github.com/Sandyzzx/codex-zcode-bridge/commit/14a865485c33eb78964f6350a783636e8ba57a00))
* add setup diagnostics and task reliability coverage ([#3](https://github.com/Sandyzzx/codex-zcode-bridge/issues/3)) ([fbcf756](https://github.com/Sandyzzx/codex-zcode-bridge/commit/fbcf75663811e2a59aabdb49b6feaf224b3d8448))


### Bug Fixes

* compare worktree roots independent of path aliases ([d25739c](https://github.com/Sandyzzx/codex-zcode-bridge/commit/d25739c9bbf49baef124cda334aaf033360c78fb))
* include loader asset in test build ([28cfb72](https://github.com/Sandyzzx/codex-zcode-bridge/commit/28cfb7201c9174a0907667eee80be0995e9ba444))

## [0.6.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v0.5.0...codex-zcode-bridge-v0.6.0) (2026-09-28)


### Features

* relay ZCode interaction requests to Codex ([fd6b1b3](https://github.com/Sandyzzx/codex-zcode-bridge/commit/fd6b1b35d86acfe43591e769900dbd75ba5ef5a5))

## [0.5.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v0.4.0...codex-zcode-bridge-v0.5.0) (2026-09-28)


### Features

* save runtime settings and automate releases ([4f09416](https://github.com/Sandyzzx/codex-zcode-bridge/commit/4f094167bee3e8924a03458347e4d30437c8432e))

## [Unreleased]
