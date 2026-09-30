# 0001 — Keep ledger authority in the COBOL core

**Status:** accepted for the local modernization lab.

## Context

The existing operator portal accepts requests into MariaDB, while the batch program owns balances in indexed files. A new customer experience must coexist with this split. Copying balances into another writable ledger would introduce two competing financial authorities during the transition.

## Decision

Keep the COBOL account files and processed-reference journal authoritative. PHP owns intake, batch membership, and imported display status. SQL Server owns modern workflow state, the transactional outbox, status history, reconciliation evidence, and read-only account projections.

All mutations enter through the existing intake/export boundary. The TypeScript worker calls authenticated PHP endpoints and preserves the request reference. Expo calls only the modern API. Account snapshots include their source generation, commit timestamp, and monotonic sequence.

The Python wrapper serializes access, creates a private copy of the indexed files, invokes COBOL, validates output and total value conservation, syncs the closed files, and publishes the generation with one atomic symlink replacement. Account and journal state become authoritative together.

## Consequences

| Benefit | Tradeoff |
| --- | --- |
| Existing allocation rules remain in one core | The new experience inherits batch latency |
| Read projections cannot independently debit value | Balances require a visible source timestamp |
| Account and processed-reference state publish together | Publication assumes local Linux rename/fsync semantics |
| Journal audit supports recovery and comparisons | The core remains a single writer; retention and backup automation are future work |

The initial total is fixed at 10,000,000 cents. There are no deposit or external payout operations in this slice. Journal-derived balance checks use that explicit fixture baseline.

## Verification

[Core tests](../../tests/test_core.py) exercise failures before/after publication, replay/conflict, concurrent access, conservation, audit, and a v0.1 indexed-file upgrade. SQL projection ordering is covered by the [integration check](../../services/server/tests/sql.integration.ts), which passed in [GitHub CI](https://github.com/CalebLouwskitter/bureau-bridge/actions/runs/36699107346).
