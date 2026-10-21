# Legacy fixed-width file contract v1

All records use ASCII, one record per LF-terminated line. Amounts are integer ZAR cents. Input rows are exactly 75 bytes excluding the newline. UUIDs use lowercase characters. The exporter publishes an immutable batch file and a JSON manifest recording count, total cents, SHA-256, and batch ID.

| Field                    | Start (1-based) | Width | Example        |
| ------------------------ | --------------: | ----: | -------------- |
| Reference                |               1 |    36 | Lowercase UUID |
| Client account           |              37 |    12 | `INS000000001` |
| Employee payable account |              49 |    12 | `EMP000000001` |
| Amount in cents          |              61 |    12 | `000000025000` |
| Currency                 |              73 |     3 | `ZAR`          |

Output begins with those same 75 bytes and adds:

| Field      | Start (1-based) | Width | Values                                           |
| ---------- | --------------: | ----: | ------------------------------------------------ |
| Outcome    |              76 |     8 | `POSTED`, `DECLINED`, `CONFLICT`, `NOTFOUND`     |
| Reason     |              84 |    20 | Space-padded code                                |
| Posting ID |             104 |    36 | Original reference when posted; otherwise spaces |

GnuCOBOL's line sequential output can omit trailing spaces. The Python boundary restores padding to 139 bytes before parsing. It validates reference order and row count against the original input. PHP validates source, target, amount, and currency before importing each result.

## Core modes

- `SEED`: creates the initial indexed account file and empty reference journal only if there is no published generation.
- `POST`: reads the input batch, looks up every reference, applies a new allocation or returns its original outcome, and publishes all resulting files as one generation.
- `QUERY`: reads the existing journal without publishing a new generation. A missing reference yields `NOTFOUND` and never causes a posting.
- `AUDIT`: reads all terminal journal entries without publishing a financial change. The JSON boundary returns at most 5000 entries and a `truncated` flag.
- `SNAPSHOT`: returns committed balances, account type/state, generation, monotonically increasing source sequence, and commit timestamp.
- `UPGRADE`: adds a missing suspended demo account with zero value in a private generation. The wrapper invokes it once for a v0.1 manifest before serving the requested operation; existing accounts and journal entries remain intact.

The indexed account layout remains 25 bytes: 12-byte ID, 12 digits of cents, and a one-byte type/state marker. `C`/`E` mean active client/employee; `c`/`e` mean suspended. The additional fixture is `EMP000000003` with marker `e`. Suspended targets decline with `TARGET_SUSPENDED`.

The 139-byte result row contains reference, payload, outcome, reason, and posting reference. Batch ID and control totals belong to the surrounding PHP manifest and SQL batch membership, rather than extra COBOL result columns. Batch reports expose expected/submitted/posted/declined counts and cents, plus unresolved counts. The exported file's SHA-256 is checked before delivery.

The journal stores terminal declines as well as successful postings. Reusing a known reference with changed data produces `CONFLICT`; the original journal entry stays intact. A decline therefore requires a genuinely new business request if the operator later changes the amount.

Input size and format are validated before COBOL runs. Core file errors leave the previous generation authoritative. Failed private generations may remain for inspection; automated pruning is deferred. The fixed record layout is an intentionally small mock interface, not an IBM mainframe protocol emulator.

## Routes and the settlement account (core format v3)

The core selects a route from the source account's type/state marker. `S` marks the active bank settlement account `BNK000000001`; `s` would mark it suspended.

| Source marker | Allowed target | Route | Decline reasons specific to the route |
| --- | --- | --- | --- |
| `C` | `E` | Allocation | `TARGET_SUSPENDED` for an `e` target |
| `E` | `S` | Payout | `INSUFFICIENT_FUNDS`, `PER_TRANSFER_LIMIT` |
| `S` | `E` or `e` | Return credit | `INSUFFICIENT_FUNDS` if settlement holds less |
| `c`, `e`, `s` | — | — | `SOURCE_SUSPENDED` |

Any other pairing declines with `ROUTE_NOT_ALLOWED`. The request and result layouts are unchanged. PHP intake accepts only the demo routes. The first access to a format v2 generation adds the zero-value settlement account in a private copy, preserving balances and journal history.

## BB-EFT v1 payout file

The payments hub writes this file; the demo bank reads it. It is a simplified fixed-width credit-transfer file with the header/detail/trailer shape of bank EFT submissions, **not** a real bank or clearing-house format. Every record is 80 ASCII bytes plus LF. Details are sorted by reference, so the same payouts always produce the same bytes.

| Record | Field | Start | Width | Example |
| --- | --- | --: | --: | --- |
| Header `H` | User code | 2 | 8 | `BUREAU01` |
| | Generation | 10 | 6 | `000001` |
| | Action date | 16 | 8 | `20261021` |
| | File ID | 24 | 36 | Lowercase UUID |
| Detail `D` | Branch code | 2 | 6 | `990001` (fictional) |
| | Account number | 8 | 11 | `10000000017` |
| | Amount in cents | 19 | 12 | `000000010000` |
| | Payment reference | 31 | 36 | Payout instruction / core debit UUID |
| | Beneficiary name | 67 | 14 | `EMPLOYEE ONE` |
| Trailer `T` | Record count | 2 | 6 | `000002` |
| | Amount total | 8 | 14 | `00000000040000` |
| | Account hash total | 22 | 18 | Sum of account numbers modulo 10^18 |

The amount total catches a changed amount. The hash total catches a changed destination account even when amounts still add up. The hub parses its own output before storing it and keeps the bytes with a SHA-256.

## Bank response

| Record | Field | Start | Width | Values |
| --- | --- | --: | --: | --- |
| Header `H` | File ID | 2 | 36 | The submitted file |
| | Generation | 38 | 6 | The submitted generation |
| | Status | 44 | 8 | `ACCEPTED`, `REJECTED` |
| | Reason | 52 | 20 | e.g. `DUPLICATE_GENERATION`, `TRAILER_AMOUNT` |
| Result `R` | Payment reference | 2 | 36 | One line per detail |
| | Outcome | 38 | 8 | `PAID`, `RETURNED` |
| | Return code | 46 | 2 | `AC` account closed, `NA` no such account, `AF` account frozen |
| Trailer `T` | Result count | 2 | 6 | |
| | Returned count | 8 | 6 | |

A rejected file has no result lines; its payouts are released for a new file with a new generation. Return codes are fictional. Real banks report returns separately over the following days; this lab returns them in the single response.
