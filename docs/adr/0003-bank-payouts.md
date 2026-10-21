# 0003 — Pay out through a core settlement account and keyed bank files

**Status:** accepted for the local modernization lab.

## Context

Allocations stopped at **Posted internally**: value reached an employee payable inside the bureau's ledger and went no further. Paying employees means sending an EFT file to a bank. That adds a second edge where the outcome can be ambiguous. A file can be sent and processed while the bank's response is lost. The bank can also return individual items days later, for example because an account was closed.

Three properties had to hold:

1. A rand that leaves by EFT is debited in the authoritative ledger first, and only once.
2. A payout can never be sent to the bank in two files, and resending a file after a timeout never pays twice.
3. A bank return credits the employee exactly once, however many times its response is processed.

## Decision

**Keep payouts as ledger postings.** The COBOL core gains a settlement account, `BNK000000001`. The source account type selects the route:

| Route | Source → target | Core rules |
| --- | --- | --- |
| Allocation | client prefund → employee payable | Existing limit, funds and state checks |
| Payout | employee payable → settlement | Active payable, available balance, per-transfer limit |
| Return | settlement → employee payable | Settlement balance; exempt from the limit and from payable suspension |

Value stays inside the fixed demo total, so the core's conservation check still proves nothing was created. The modern hub never adjusts a balance. It creates postings through the same outbox, PHP intake, batch file and COBOL journal as every other request, and inherits their replay protection.

**One reference per payout.** The payout instruction's Id is the Id of its core debit allocation. It is also the payment reference on the item's line in the EFT file. One identifier traces the money from the API request to the bank.

**Files claim payouts under a lock.** Generating a file locks the client's file range, then claims every instruction whose core debit is `POSTED` and that has no file. It writes the file row and sets each instruction's `PayoutFileId` in one transaction, failing if any claim was lost. The request carries an idempotency key, and replaying it returns the same file. The file content is built deterministically, parsed back before it is stored, kept as bytes with a SHA-256, and served unchanged for any resend.

**Ask before resending.** Each file has a per-client generation number. Before sending, the hub asks the bank for the response to that generation, the same lookup-before-submit rule the worker uses with PHP. An unanswered inquiry never authorizes a send. The demo bank answers a repeat of identical bytes with its original response, and refuses different bytes under a used generation.

**Process each answer once and key the credits.** `BankResponses` is keyed by file. A repeat of the same response is reported as a duplicate; a different response for the same file is a conflict. A returned item creates a `RETURN` allocation whose idempotency key is a name-based UUID derived from the payout Id. No path can create a second credit for the same payout, and the core journal deduplicates the delivered reference as a second layer.

**Reconcile settlement.** Every cent held in settlement must be explained by a payout instruction whose debit the core posted and whose return has not been credited. The break report also flags settlement postings without an instruction, files claimed by instructions whose debit never posted, file lines that disagree with their claims, altered stored files, unknown submissions and pending return credits.

## Consequences

| Benefit | Trade-off |
| --- | --- |
| The ledger stays the only financial authority | A payout needs a batch for its debit before it can be filed, and another for any return credit |
| Existing replay and recovery machinery covers payouts | Settlement accumulates value paid out; a real ledger would clear it daily against the bank statement |
| A payout is in at most one file; resends are safe | File generation is serialized per client |
| Returns credit exactly once | The demo processes one response per file; real banks send returns separately over the following days |
| A rejected file releases its items for a new file | An operator must check why a file was rejected before regenerating |

BB-EFT v1 is a simplified fixed-width format with the header, detail and trailer shape of bank credit-transfer files. It carries a record count, an amount total and an account-number hash total. It is not a real bank or clearing-house format. Bank details and branch codes are fictional.

## Verification

[Core tests](../../tests/test_core.py) cover payout and return postings, a replayed return, route and funds rules, and the format v3 upgrade. [Server tests](../../services/server/tests/payouts.test.ts) cover deterministic files, trailer tampering, the bank simulator, lost-response recovery, the break report and API roles. The [SQL test](../../services/server/tests/sql.integration.ts) covers concurrent instruction and file creation on SQL Server, once-only response processing and the return credit. The [smoke scenario](../../scripts/smoke.mjs) runs the whole leg against the Docker stack, including a lost bank response.
