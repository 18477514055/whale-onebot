# Public source: release decision and local gate

**Never push the eleven-commit branch or publish the original RC core ZIP.** A product-scale, independently pinned local source candidate and regenerated RC artifacts now exist (below). The two-file example later in this document is only an ancestry demonstration. The product candidate is not authorization to publish, install over an existing account, or claim all native redistribution obligations are satisfied.

## Product candidate and actual artifact review

The initial core ZIP contained a private numeric QQ principal in `payload/src/onebot/local-account-guard.js` and 34 path-bearing source files. This was an actual packaged account, not just a possible secret-scanner hit. Do not distribute that ZIP or its original pin. The Android built-in instance slug is **not** this account: the slug already occurs in the public base's registry and must remain stable for deployed ownership. The private primary installation was not read or changed.

`python scripts/check-public-candidate.product.py` consumes the three exact original private RC ZIP hashes and the pinned public [upstream revision](https://github.com/sakurawwwxh/qq-agent-plus/tree/4488db71b0697d26feeee1131877573ddc440d9f) (`.tmp/public-agent-upstream-fixed.zip`, SHA-256 checked). It reads entries in memory, verifies exact membership and per-file hashes before transformation and writes only sanitized sources in a fresh ignored directory. All 28 role/skill files matched that public revision after normalizing line endings. No role file is taken from private runtime data. Public UI examples replace three locally modified UI files; the release does not project private legacy memory or append local persona prompts. The implicit account is unset and both event and owner-notification guards deny it; explicit canonical per-binding QQ/Bilibili guards remain. For legacy installations **do not use these source-only modules as a drop-in upgrade**; enroll a selected binding or keep the existing private core. 303 app JS modules parsed. Negative tests denied implicit null/zero/foreign IDs, an empty explicit binding and the private legacy projection. A canonical explicit QQ binding constructed successfully.

**1.1.1 re-pin (2026-11-22).** Owner changes since that base are exactly ten app files (eight new `src/features/bili-behavior/*.mjs`, plus `src/server.js` and `src/binding-supervisor.mjs`) and six Bilibili protocol sources (`src/platforms/bilibili/actions/reply.mjs` added; `account-actions.mjs`, `actions/community.mjs`, `authorized-client.mjs`, `client.mjs`, `service.mjs` changed). `python scripts/snapshot-release-app.py --base <reviewed base> --changed <declared paths> --out <new tree>` rebuilds the reviewed tree from the working tree, re-applies the same public projections (implicit account unset; legacy enrollment disabled; the three UI files reset to upstream; comment-line scrub for host paths and installation identities) and **fails on any undeclared drift**, so an unlisted edit cannot reach an artifact. `python scripts/snapshot-release-protocol.py` does the same for the protocol sources and rejects host paths, billable tokens and the installation identities. New pins: app `0ff7be2a17dcfe205acd88c08679717055e47b1fbe12b62207d13130525282d1` (352 app/module/notice files) and protocol `1957a3c0359cc362a6f8875cd473d913740939aaf9bb8cfac130916ff78ba3e9` (24 protocol/environment sources and notices). Built with the same curated Debian subset (`a0018f84…85fd2`) and corresponding-source sidecar (`265c294b…51048`): release index `18cffc0c9b080031859b22c0284051dd4c26bce99751ee285ee11eb0d7e378ca`, environment `51 240 504` B `8650c60f2a663aff6e55635064d35d5005f087dc487960f03aefa1801292a74b`, packaging test 3/3.

The clean input manifests (`app-manifest.json`, `protocol-manifest.json`) use `{schemaVersion:1,files:{relative/path:sha256}}`, canonical UTF-8 JSON plus LF. Their external SHA-256 pins are `fffe7a143b7bbb6e9cdfa4a88f26ca404e51e9bbc281be9284bd6967868ecf6f` (344 app/module/notice files) and `e8632534a8c80b47889a44f6385135a34a1d0b2bd33d102ff7abcf87d180d307` (23 protocol/environment sources and notices). `python scripts/check-public-candidate.snapshot.py .tmp/product-source-review-soka0_xp` assembles these plus the 127 exact current Android/build/selected-test/notice inputs pinned in `scripts/check-public-candidate.inputs.json` on a single public-base parent. It rejects even one changed byte, verifies the entire tree, and checks that none of the eleven private commits exists in its independent repository. Review current owner changes before repinning. Actual result: `.tmp/product-public-base-2g2x3ty6`, commit `6a5f730fc699c11676d2cd28c160e5c9ee88d2ad`, exactly one public-base parent; 496 selected inputs, 746 paths in the resulting tree, zero private commit objects. The isolated candidate passed `python -m unittest discover -s test -p test_bot_modules.py` (1 packaging/integration test). This is a release **source review** snapshot, not a novel full-native-rebuild proof.

**Independent readback from the regenerated RC** (`.tmp/bot-release-v1.1.0-rc.1-reviewed`): release index SHA-256 `bad926f27dfc2f81dd1d55ebe41c53936f3ff4280bb3a6b290ee742cea180163`. Inflated all ZIP members and compared them against the independent source manifest: 335 core, 4 QQ and 5 Bilibili payloads (excluding their manifests), zero extra/missing. Replacement core SHA-256 `e6782b88fac77296f118aca67facdd43e103307979984be2bd082cb0b4a98f58`; all 23 selected protocol files matched within the compressed environment. The corresponding-source sidecar's top-level proof, manifest and build script were separately screened for desktop paths and credential markers. Native provenance and source-offer review are separate release gates; absence of pattern hits does not settle licenses.

**Signed APK** (`.tmp/d282-reviewed-signed/whale-onebot-release.apk`), SHA-256 `f91a0184d9a3c9e5a36e09fd2a9ff234c91e4621cc23a3d50b0c5298d8a838e9`: inflated all 23 entries; four JS assets matched the pinned local sources modulo CRLF; embedded release pin JSON matched the reviewed package pin. The known private account and fixed device selector/address were absent in ASCII and UTF-16LE, no conventional billable-key/private-key pattern matched, and the sole 803164-byte DEX had no host user-directory path markers. This is a targeted static check, not proof against every unknown, encoded or dynamically fetched secret. No device, account, release API or public branch was modified. Require separate owner authorization and release-audit sign-off before public writes.

## What was actually checked

Run from the repository root, with Python 3, Git and (for the candidate's tests) Node. No service, network credentials, device, backups, or live profile are needed.

```text
python scripts/check-public-candidate.py self-test
python scripts/check-public-candidate.py audit
python scripts/check-public-candidate.py export
```

`audit`: 0 = no private delta found to review, 1 = hold, 2 = incomplete/error. The gate reads Git objects, not raw diff output: it compares the public-base tree with **every** local commit tree, also checks the net tip, staged additions/modifications and tracked working-file changes. New files staged locally count; unrelated untracked and ignored files are deliberately neither read nor eligible for export. Binary/non-UTF-8 blobs and nonregular entries require review. Counts describe distinct **path/blob versions**, not numbers of credentials or people, and categories overlap. It never prints matched text, private file names, or raw Git errors. This is screening, not a proof that unknown strings are harmless. It does not audit already-published history or approve its contents; private commit messages/authors are excluded by construction.

Run on 2026-11-20 against the local `origin/main` (public base `2cecfab452081be18998f1691a45600bfd6fd8a7`): 11 local commits, 468 net changed paths (466 surviving changed entries, two deletions), 536 distinct historical path/versions. Audit returned **1**, as intended.

| Review signal | Net tip | Historical versions |
|---|---:|---:|
| Device selector | 1 | 1 |
| Host path | 39 | 43 |
| LAN address | 7 | 11 |
| Pinned legacy binding | 2 | 3 |
| Literal machine identity | 1 | 1 |
| Numeric principal-like | 138 | 173 |
| Credential-like | 9 | 10 |
| Opaque / not proven UTF-8 source | 1 | 1 |
| Imported or third-party provenance | 343 | 379 |

The index had no additional staged blobs in the recorded run. The working tree was being edited concurrently (18 changed tracked files in one sample); rerun immediately before selecting anything. The export intentionally ignores both the working tree and index.

* **Actual device binding:** `scripts/stage-phone-bili-rollout.mjs:9` declares a fixed selector; line 49 passes it to the device tool. Do not copy that script or logs. A public rollout tool should require an explicit, privately supplied target and fail closed if not supplied.
* **Actual legacy identity dependency:** `android/app/src/com/whaleonebot/ui/BotRegistry.java:58,81–83` ties ownership/compatibility to an embedded instance ID. Do not globally substitute a sample ID: existing accounts, ownership checks and persisted bindings may cease to match. Exclude the affected host and fixtures. A future coordinated change should resolve the **existing** installation-specific ID from private state, demonstrate the same identity/authorization before and after migration, and test missing/ambiguous/rollback cases using disposable fixtures. No deployed migration was attempted here.
* **Other findings:** identity-like numbers and addresses include possible fixture or protocol constants. Credential-pattern matches include documentation, secret-handling implementation, and tests; they are **not nine verified live secrets**. Hold unresolved hits for private owner review; rotate confirmed exposed credentials through the provider, not a source substitution. Never paste values in review comments. No real login or credential validity test was performed.
* **Licenses:** root MIT text and the retained imported-app MIT license match the public base; `THIRD_PARTY_NOTICES.md` changed. The import adds 340 tracked `input/agent-app/` paths including an asset notice. All four vendored Java QR source files contain permissive license headers. This is evidence of notices, **not** blanket redistribution clearance for fonts, images, dependencies, or bundled binaries. Map each new component to its revision, source, license, and required notices; preserve headers and review actual asset bytes separately. Missing rights or an unexplained opaque blob means exclude. Do not replace the new notice file with the old one for a full release.

## Construct and validate a genuinely independent candidate

`export` accepts **no** arbitrary include path. It accepts only the two exact committed blobs and public parent pinned in the script. It reads raw Git bytes, verifies SHA-256 and screens them again. One exception is restricted to the exact test digest: the single deliberately invalid device-ID value passed to a rejection assertion. The production client has no exception. Unknown files, changed digests, flags, or moved public base are never silently accepted. The package and license remain those of the inherited base; no new non-built-in dependency is needed for this two-file delta.

In a fresh ignored scratch directory it initializes Git with no hooks/template or remote, fetches **only the local public-base commit** (file transport only, no tags), starts the index at that tree, writes the two blobs, and creates one commit with neutral authorship. It checks the exact parent and final tree, byte-verifies the two additions, and proves that none of the eleven private commits exists in the scratch object database. Only then is the candidate checked out. It does not create a branch, checkout, or commit in the product repository. Never push or merge the private branch, clone it as a public seed, export the entire worktree, or stage indiscriminately.

For the generated scratch path printed by `export`, run:

```text
node --test --test-reporter=tap <scratch>/test/bili-client.test.mjs
git -C <scratch> diff --stat HEAD^ HEAD
git -C <scratch> rev-list --parents -n 1 HEAD
git -C <scratch> remote
```

Tested: one public-base parent, two additions (`src/platforms/bilibili/client.mjs`, `test/bili-client.test.mjs`), zero remotes or private commit objects, seven offline tests passed and none failed. Commit ID may change on rerun because commit time changes. Do not upload the scratch directory or assume the original public base itself was audited for pre-existing issues.

## Before expanding to a product release

Freeze coordinated edits first. Prepare a **new reviewed manifest** of exact paths and digests for source, compatible tests, license notices and build inputs. For the pending release these include the catalog builder, its tests and docs, integrity pins and upstream notices under `scripts/release-inputs/`, and any release-audited environment-subset tooling. They are **not** cleared by this two-file exercise. Review each addition offline; prefer public templates and install-time private settings over scrubbing live files. Never include private device plans, environment files, generated caches, runtime data, backups or signing materials. Recreate from the verified public base, run the relevant offline build/tests from the exported tree, verify the delta and parent independently, and obtain explicit release approval. If a distributed binary needs corresponding source, a partial candidate does not satisfy that requirement.
