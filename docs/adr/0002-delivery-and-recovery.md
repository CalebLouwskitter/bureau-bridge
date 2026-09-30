# 0002 — Deliver stable references and recover by inquiry

**Status:** accepted for the local modernization lab.

## Context

The modern SQL transaction, PHP intake, core execution, and result import cannot complete as one shared transaction. A process or network failure can leave the sender uncertain whether the receiver recorded a request or committed an allocation. Creating a new reference on retry could duplicate the intended business operation.

## Decision

Persist the allocation and its outbox entry in one SQL Server transaction. A client idempotency key identifies replay of the same API request; reuse with a different payload is rejected. The worker delivers the allocation's immutable reference and checks the existing legacy intake before submitting it.

The core journal records terminal postings and declines under that reference. Replaying identical data returns the recorded result; different data under the same reference produces a conflict. The core wrapper publishes balances and journal together.

Worker jobs have lease tokens. A replaced token cannot finalize a newer claim. Transient failures back off and enter `NEEDS_REVIEW` after six consecutive failures. An unresolved delivery or lookup does not establish a financial outcome. `POSTED` and `DECLINED` are immutable final states.

Recovery has two explicit operations:

| Operation | Behavior |
| --- | --- |
| Core inquiry | Read the journal and import an existing outcome without posting |
| Verify and resume | Hold the batch lock, inquire, and requeue only after the core reports `NOTFOUND` |

The mobile client saves its unfinished request before sending. Retrying that request after a transport failure or app restart preserves the idempotency key and payload. Batch membership is stored separately so moving a request into a later batch cannot erase the original export controls.

## Consequences

Delivery can repeat while ledger mutations remain deduplicated by durable references. Ambiguous results stay visible for investigation. Reconciliation captures differences across layers, including import lag; it does not automatically authorize reposting or manufacture a new business request.

The prototype uses one employer fixture, bounded retries, and explicit operator recovery. Broader reconciliation, retention, identity, and deployment policies can extend this foundation.

## Verification

[API/worker tests](../../services/server/tests/system.test.ts) check lookup/retry behavior, immutable final jobs, payload mismatch, roles, and saved-request parsing. [Core tests](../../tests/test_core.py) and the [real PHP integration check](../../tests/legacy_integration.php) exercise committed-but-missing results and verified unposted resumption. The [SQL test](../../services/server/tests/sql.integration.ts) covers transactions and lease fencing when a SQL Server runtime is available.
