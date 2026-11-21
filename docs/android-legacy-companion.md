# Add Bilibili without replacing the primary QQ robot

The special case is the enabled built-in robot `whale-1` with precisely one implicit QQ binding (no QQ account override and no explicit transport URLs). Adding a Bilibili binding leaves that QQ binding on the original process, original config and data. The additional supervisor starts Bilibili workers only; it does not start a second QQ client. It reads the primary config by reference (`QQ_AGENT_LEGACY_COMPANION=1`, `/agent/data/config.json`). Other robot IDs do not receive primary config or memory. A Bili-only robot does not start QQ. The private shell debug marker does not enable `/exec` or `/raw` in a hybrid registry.

**Owned vs external:** For Bilibili a numeric expected UID plus empty HTTP **and** WS URLs selects an owned service. Two explicit loopback URLs select an externally managed OneBot service. Starting a protocol process or visiting a login page is not verification; the locally held process must verify the expected identity before its ephemeral endpoint and bearer are made available to a runtime. The local bearer is not an upstream cookie. Inspect Bilibili protocol state separately from worker readiness and from the existing QQ account.

**Offline registry projection** (run in the workspace against a privately obtained snapshot, not the live path):

```text
node scripts/project-legacy-bili-registry.mjs ORIGINAL.json PROPOSED.json CONFIRMED_BILI_UID
node --test test/android-binding-host.test.mjs test/android-bili-host.test.mjs
```

The CLI refuses to overwrite any output, prints before/after SHA-256 only, preserves unrelated JSON fields, and leaves original bytes untouched. Keep the original privately with its digest. Use the UI for ordinary edits. For an operator-managed maintenance replacement, quiesce registry writers, verify the live original digest, stage the proposed bytes on the same filesystem, replace atomically, and verify the installed digest **before resuming writers**. For rollback, stop only the added workers/protocol, quiesce writers again, and replace atomically with the original only if the current registry still matches the proposed digest. Otherwise merge the unrelated edits instead of restoring a stale snapshot. Revert staged APK/runtime files from their own backups as necessary. Never clear app data or recreate the bot. Local tests check the projection, restore exact original bytes in an inactive fixture, and launch a Bili-only companion fixture without modifying the primary config. They do not establish device login, delivery, or safe interruption of a live phone.
