# Process checks and safe recovery

Failed checks preserve known PIDs/groups. Failed discovery or saving an unidentified child retains the unknown-process safeguard. Supervisor diagnostic failures are separate; actual uncertainty still refuses completion. Diagnostics omit arguments, environments and raw errors.

Passing tests, empty ancestry or service restart alone cannot prove exit. Normal [deployment](../scripts/deploy-browser.mjs) still drains, backs up, checks database compatibility and installs one verified UI/worker build. Fresh positive proof can enable this narrow legacy recovery without a Mac restart.

## Preserve known IDs after a recording failure

The observer captures every process ID in a scan before calling persistence. If a normal descendant write fails, the built-in recorder reserves a new guard, then saves the failed ID and all remaining IDs together in one transaction. A successful commit lets ordinary exit checks continue. A crash or failed transaction leaves the fresh guard unresolved. External observer callbacks are not replayed; process scans that fail still retain the unknown-process safeguard. Stop operations keep their conservative failure path rather than signalling from a snapshot delayed by fallback persistence.

SQLite failures retain a fixed error code in diagnostics, without paths, arguments or raw messages. This prevention does not reconstruct an ID lost by an older build, settle an existing unknown row, or establish that a process exited. Historical recovery below still needs its positive source and OS observations.

## Witnesses without a PID

Each spawn reserves its witness before the OS call. When the spawn makes no process (ENOENT, EAGAIN, a throw from the spawn call, or no OS object), the spawn road settles that witness as never started right away, even if the transport throws afterwards.

`reconcile` settles any other PID-less witness only on this host, only for a finished run with no tracked child, where every other witness has exited and every recorded process group is gone when rechecked. It writes a `process witness settled` ledger entry. A run whose only witness has no PID stays unproven.

When the evidence can't settle a finished run either way, an approver can use `toolroll run settle <run> --why "<reason>" --as <you> --token <t>`. It refuses while any recorded process of the run is alive, a native object still has members, or a witness belongs to another host. It never sends a signal. It records the reason against the approver in the ledger.

## Inspect and record

The local API is `recoverPreparedObserverGap(store, { profilePath, compilationDirectory, evidenceRoot, mode })`. Start with `mode: "inspect"`; it changes no custody. `"record"` recollects internally. No caller-supplied executable/anchor/serialized success, general CLI, remote endpoint, force-clear flag or migration is added.

The pinned private profile binds positive historical command completion, audited app/runtime/source bytes and logs. Authenticated watch renewal binds a pre-run service identity. Eligibility retains original scope/signer/project/route/grant authority, authentic handoff/executed gate, terminal runs, known spawn exits, and no active work, stop or owned producer. Later reviews do not rewrite the gate or prove exit.

Record saves complete observations and original rows in an exclusive private hash-addressed certificate. One write transaction/savepoint rechecks eligibility and every witness field, updates only eligible unknown rows' exit-observed time, requires normal quiescence, and appends the certificate hash to the ledger atomically. A certificate without the committed ledger entry is observation-only. Collector cleanup waits for owned `close`; a kill request is not exit evidence.

## Limits

Recovery covers direct/ordinary-fork descendants under the audited path and trusted OS/app/toolchain/dependency/configuration/log model. Historical HOME/PATH/npmrc/lifecycle/Git configuration was not sealed. It does not invent a no-delegation attestation or prove absence of malicious/delegated launchd/XPC work.

Ordinary fork/exec inherits coalition membership; the audited path must not request privileged selection or delegate work. Source-coalition privilege itself is unknown. Every non-zombie PID needs readable membership or membership ESRCH followed by fresh identity ESRCH. Permission errors refuse. Counts corroborate identities, never classify unreadable PIDs as foreign. Anchors are revalidated; changed identity/ancestry, tracing and incomplete reads refuse. Unbound PID 1 orphans remain unresolved after exec. Wall birth and 32-bit parent generation are not authority.

The narrow app-service collector recognizes the pinned Apple speech service only when repeated launchd records bind it to an exact pre-run Chrome owner. Complete native snapshots bracket those observations. The service, owner, boot, coalition and authenticated anchor identities must remain unchanged. Pending PID 0 entries create no binding or exit claim; any unmatched live process remains unresolved. Names and a launchd parent alone are insufficient; an unrecognized platform, executable or owner refuses recovery. These facts are sealed inside the live opaque provenance receipt, never supplied to record mode by its caller.

The adapter pins Darwin 25.5.0/macOS build 25F84 and the inspected launchctl, codesign, Speech plist and executable bytes. It accepts the normal Chrome executable or one exact audited clone path hash and binary hash, not arbitrary temporary paths. The clone requires positive dynamic `codesign --verify --strict +PID` and matching observed Chrome identifier, Google TeamID and code-directory hash. Static strict resource verification refused Finder metadata on both the clone and installed app; no metadata was removed and no static pass is claimed. Current kernel exec-version comparisons detect changes during observation; they do not replace the authenticated 64-bit historical bound.

Launchctl print is explicitly not a stable API. The platform-specific parser requires complete balanced records and singleton identity fields, rejects malformed or injected nested/environment data, and returns no raw environment. Unknown platform or code identity remains a refusal. The last observation is a fresh complete native census; subprocess completion and service ownership are facts, not permission to stop another application.

XNU adopts a child before publishing its PID and making it runnable. Inventory therefore requires positive original-command/spawn completion and no remaining producer. [Published XNU](https://github.com/apple-oss-distributions/xnu/blob/main/doc/observability/coalitions.md) supports the argument; installed 12377.121.10 is not claimed bitwise equivalent to public 12377.121.6. The release kernel lacks the debug-only PID-list API.

## Evidence and release

[checks.json](../evidence/process-recovery/checks.json) binds source hashes/blobs and complete readable focused receipts. Do not sum overlapping counts. Older unchanged checks, superseded output and failures remain losslessly archived as historical preparation, not current criterion proof. Provenance success is not survivor-assessment or settlement success.

Historical development base `431603ee9399b86ea32ff76ae8288255558acb25` is not a verified release base. This integration starts at fully verified native foundation `b3b6253c19fa717157b66c87e50ed8fef08f90cd` (builder1944, review1945 with format child1946). The earlier prepared foundation `a585c71f5ada87e52177038783e6ada304cf1db7` remains historical. Preflight the complete committed candidate against its original verified base before first dispatch. The unchanged native gate and independent review remain required. `REVIEW-VERIFICATION.json`/`REVIEW-CHECK-LOG.txt` bind execution; compare source blobs with `REVIEW-CONTEXT.json` identities, not redacted-text hashes.

Private inventories/logs, credentials and database snapshots stay out of public evidence. Packaging/probes do not settle custody, migrate, dispatch or deploy. Publication and normal update checks remain separate.
