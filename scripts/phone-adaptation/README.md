# Phone adaptation: offline preflight kit, not a deployment

Run from the original project with Node24:

```text
node scripts/phone-adaptation/preflight.mjs
node scripts/phone-adaptation/preflight.mjs --inspect-fixed-artifacts
node scripts/phone-adaptation/prepare.mjs
node --test test/phone-adaptation*.test.mjs
```

The first command reads only four fixed, non-sensitive ARM64 evidence JSON files;
it does not read any binary. The optional second command additionally reads only
the fixed `.tools` Node/wrapper and original synthetic `.tmp` host-provider/loader
ELF paths (four files); SHA256 must match before parsing.
It inspects ELF64/LE program headers, machine, interpreter and DT_NEEDED without
executing/importing binaries. No shell, SSH, ADB, downloads, package installs,
network, production ports, environment dump or existing robot state is involved.
All report JSON goes to stdout; no report file is written automatically.

Exit **2** means a valid report with deployment BLOCKED/NOT_PROVEN, not a tool
crash. Exit **1** means malformed, changed, unavailable or unsafe input. Errors
contain fixed error codes only, not input content, paths or underlying messages.
Exit **0** is help or successful preparation, never deployment permission.

## What preparation actually packages

`prepare.mjs` creates a fresh `prepared/bundle-*` directory **under this tool**.
It copies only seven explicitly named original tool/example/doc files plus a
sanitized historical baseline snapshot and a local-digest manifest (nine files).
No QQ, Node, `.node` binary, `src`, `node_modules`, account/session/config/database,
business data, APK or launcher is bundled. It does not recursively copy anything,
overwrite an output or delete a prior bundle. It never installs the bundle.
The manifest is a local integrity aid, not an upstream signature.

In the prepared kit, run `node preflight.mjs --snapshot`. This consumes the
historical projection; it does **not** re-check the original evidence or binaries.
Running a tool-only kit on a future phone still does not validate a QQ runtime.
The kit needs an independently authorized new-UID Node24 runtime to run there;
no such phone runtime is supplied or accessed by these tools.

## Optional non-sensitive declarations

After independently authorized synthetic device work, copy the example to
`inputs/device-facts.json` **next to the tool**, then use `--with-facts` (combined
with `--snapshot` in a kit). No device command is executed by this flag.

Allowed fields are exactly the example's eight keys. `androidApi` is null or an
integer 21..100; `androidAbis` contains only `arm64-v8a`, `armeabi-v7a`, `x86`,
`x86_64`; runtime platform is null/`android`/`linux`; architecture is
null/`arm64`/`arm`/`x64`/`ia32`; Node version is null or `v24.20.0`-style numeric
version; libc is null/`bionic`/`glibc`; route is `unselected`, `android-bionic`,
or `linux-glibc-in-new-uid`. Extra fields or arbitrary strings are rejected.
Never place tokens, hostnames, addresses, account data, raw logs, credentials or
old environment files in this input. These facts are **unverified declarations**;
even matching values cannot turn a device/runtime/isolation gate into PASS.

## Actual limits

- Fixed Linux ARM64 QQ/Node are glibc, not Android Bionic binaries. A Bionic route
  blocks direct QQ loading; it may later test original JS + synthetic bridge only.
- The local Node24/QEMU smoke test and original two-symbol host-provider/loader
  check are historical synthetic PC evidence, not Android or real QQ ABI evidence.
- The existing media worker requires Sharp 0.35.5 and target-specific addon/libvips.
  The tool reports this NOT_PROVEN; it does not inspect/copy PC node_modules, acquire
  Android/ARM64 packages or silently disable original media behavior.
- The known QQ dependency closure remains incomplete and 12 wireless-photo
  providers/initializer reachability remain unresolved. No stub is generated.
- Separate directory/PRoot is not Android UID isolation, and separate UID does
  not imply separate loopback/network. No isolation claim is made by this kit.
- Matching hashes/machine/needed lists do not prove symbol resolution, glibc
  versions, ABI compatibility, actual QQ loading, background stability or lower
  Tencent kick rate. Official page re-fetch/redistribution permission is unproven.
- Link/junction/hardlink and bounded-input checks protect a static trusted PC
  workspace. They are not an OS sandbox against concurrent privileged renames;
  Windows lacks O_NOFOLLOW. Do not point these tools into untrusted mutable trees.
- Current Linux normal-operation D12/D13 scope is respected; this kit does not
  change original business rules or expand permission to modify phone production.
