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
