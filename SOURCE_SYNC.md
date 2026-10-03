# SGX source synchronization record

This branch is a reviewable mirror of the committed SGX automatic classification handoff scope. It is based on the target repository's `main` branch and does not rewrite that branch.

## Source and scope

- Source repository: `https://github.com/GOATWEN6/SGX.git`
- Source branch: `codex/classification-contract-v1`
- Mirror branch: `codex/classification-t1-handoff`
- Included: classification contracts, runtime and Worker code, Feature Service, local lab reference code, harness tests, classification scripts, and associated algorithm/specification documents selected by the source `classification-handoff-package` boundary.
- Excluded: uncommitted source work, secrets, `.env` files, private keys, model weights, real user media, generated archives, temporary run directories, `node_modules`, build/cache output, local databases, and `figures/` media.
- Target repository `LICENSE` is retained from `main`.

## Sync history

| Synced at (UTC) | Source commit | Verification status | Change summary |
|---|---|---|---|
| 2026-10-03T02:08:12Z | `41359626629ef32b8301f788ac1f80f432247244` | Source commit accepted as the verified handoff baseline; target snapshot scan and integrity checks are recorded in the corresponding target commit. | Freeze the real hybrid T1 and full stack handoff completion plan. |
| 2026-10-03T02:09:13Z | `306f1c8130210320f444e6ebaa63d667f7a772e4` | Documentation only; mirror secret scan and integrity checks are recorded in the corresponding target commit. | Clarify the Worker backed T1, historical projection, and PCM WAV ASR boundaries. |

## Integrity rule

Each target commit records one source SHA in its commit message. Before push, the final branch is scanned with the repository secret scanner and checked for forbidden file classes and whitespace errors. Verification of the mirror confirms packaging integrity; it does not upgrade offline or synthetic evidence into real user accuracy or production readiness.
