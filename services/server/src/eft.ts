import { createHash } from "node:crypto";
import { UUID } from "@bureau/contracts";

// BB-EFT v1: a simplified fixed-width credit transfer file modelled on the
// header/detail/trailer shape of bank EFT submissions. It is not a real bank
// or clearing-house format. Every record is 80 ASCII bytes plus LF.
export const RECORD = 80;
export const USER_CODE = "BUREAU01";
export const MAX_ITEMS = 500;
export const RETURN_CODES: Record<string, string> = {
  AC: "Account closed",
  NA: "No such account",
  AF: "Account frozen",
};

export class EftError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface EftItem {
  reference: string;
  branch: string;
  account: string;
  amountMinor: number;
  holder: string;
}
export interface EftFile {
  userCode: string;
  fileId: string;
  generation: number;
  actionDate: string; // YYYY-MM-DD
  items: EftItem[];
}
export interface BankResult {
  reference: string;
  outcome: "PAID" | "RETURNED";
  code: string | null;
}
export interface BankResponse {
  fileId: string;
  generation: number;
  status: "ACCEPTED" | "REJECTED";
  reason: string | null;
  results: BankResult[];
}

const digits = (value: number | bigint, width: number) => {
  const text = value.toString();
  if (!/^\d+$/.test(text) || text.length > width)
    throw new EftError("FIELD_WIDTH", `${text} does not fit ${width} digits`);
  return text.padStart(width, "0");
};
const text = (value: string, width: number) => {
  if (!/^[A-Z0-9 _]*$/.test(value) || value.length > width)
    throw new EftError("FIELD_WIDTH", `Invalid text field ${value}`);
  return value.padEnd(width, " ");
};
const record = (line: string) => {
  if (line.length > RECORD)
    throw new EftError("RECORD_LAYOUT", "Overlong record");
  return line.padEnd(RECORD, " ") + "\n";
};
const lines = (content: string) => {
  const rows = content.split("\n");
  if (rows.at(-1) === "") rows.pop();
  if (
    !rows.length ||
    rows.some((r) => r.length !== RECORD || !/^[\x20-\x7e]+$/.test(r))
  )
    throw new EftError(
      "RECORD_LAYOUT",
      `Every record must be ${RECORD} ASCII bytes`,
    );
  return rows;
};
const number = (field: string, code = "RECORD_LAYOUT") => {
  if (!/^\d+$/.test(field))
    throw new EftError(code, `Expected digits: ${field}`);
  return BigInt(field);
};

export const sha256 = (content: string) =>
  createHash("sha256").update(content, "utf8").digest("hex");
// Like a bank hash total: the sum of destination account numbers lets the
// receiver detect a changed account even when the amount total still matches.
export const hashTotal = (items: Pick<EftItem, "account">[]) =>
  items.reduce((sum, i) => sum + BigInt(i.account), 0n) % 10n ** 18n;

// The same inputs always produce byte-identical content, so a stored file can
// be checked by hash and resubmitted safely.
export function buildEft(file: EftFile): string {
  if (!file.items.length || file.items.length > MAX_ITEMS)
    throw new EftError("ITEM_COUNT", `A file holds 1 to ${MAX_ITEMS} items`);
  if (!UUID.test(file.fileId) || !/^\d{4}-\d{2}-\d{2}$/.test(file.actionDate))
    throw new EftError("HEADER", "Invalid file identifier or action date");
  const items = [...file.items].sort((a, b) =>
    a.reference < b.reference ? -1 : 1,
  );
  if (new Set(items.map((i) => i.reference)).size !== items.length)
    throw new EftError(
      "DUPLICATE_ITEM",
      "A reference may appear once per file",
    );
  let out = record(
    "H" +
      text(file.userCode, 8) +
      digits(file.generation, 6) +
      file.actionDate.replaceAll("-", "") +
      file.fileId,
  );
  let total = 0n;
  for (const i of items) {
    if (
      !UUID.test(i.reference) ||
      !Number.isSafeInteger(i.amountMinor) ||
      i.amountMinor < 1 ||
      !/^\d{6}$/.test(i.branch) ||
      !/^\d{11}$/.test(i.account)
    )
      throw new EftError(
        "DETAIL",
        "Invalid item reference, amount or bank details",
      );
    total += BigInt(i.amountMinor);
    out += record(
      "D" +
        i.branch +
        i.account +
        digits(i.amountMinor, 12) +
        i.reference +
        text(i.holder.slice(0, 14), 14),
    );
  }
  return (
    out +
    record(
      "T" +
        digits(items.length, 6) +
        digits(total, 14) +
        digits(hashTotal(items), 18),
    )
  );
}

export function parseEft(content: string): EftFile {
  const rows = lines(content);
  const header = rows[0],
    trailer = rows.at(-1)!,
    details = rows.slice(1, -1);
  if (
    header[0] !== "H" ||
    trailer[0] !== "T" ||
    details.some((d) => d[0] !== "D")
  )
    throw new EftError(
      "RECORD_LAYOUT",
      "Expected one header, details and one trailer",
    );
  const fileId = header.slice(23, 59),
    date = header.slice(15, 23);
  if (!UUID.test(fileId) || !/^\d{8}$/.test(date))
    throw new EftError("HEADER", "Invalid file identifier or action date");
  const items = details.map((d) => {
    const reference = d.slice(30, 66);
    if (!UUID.test(reference))
      throw new EftError("DETAIL", "Invalid item reference");
    return {
      reference,
      branch: d.slice(1, 7),
      account: d.slice(7, 18),
      amountMinor: Number(number(d.slice(18, 30))),
      holder: d.slice(66, 80).trimEnd(),
    };
  });
  if (!items.length)
    throw new EftError("ITEM_COUNT", "A file must contain items");
  if (new Set(items.map((i) => i.reference)).size !== items.length)
    throw new EftError(
      "DUPLICATE_ITEM",
      "A reference may appear once per file",
    );
  if (number(trailer.slice(1, 7)) !== BigInt(items.length))
    throw new EftError(
      "TRAILER_COUNT",
      "Trailer record count differs from details",
    );
  if (
    number(trailer.slice(7, 21)) !==
    items.reduce((s, i) => s + BigInt(i.amountMinor), 0n)
  )
    throw new EftError(
      "TRAILER_AMOUNT",
      "Trailer amount total differs from details",
    );
  if (number(trailer.slice(21, 39)) !== hashTotal(items))
    throw new EftError(
      "TRAILER_HASH",
      "Trailer account hash total differs from details",
    );
  return {
    userCode: header.slice(1, 9).trimEnd(),
    generation: Number(number(header.slice(9, 15))),
    actionDate: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`,
    fileId,
    items,
  };
}

export function buildResponse(r: BankResponse): string {
  let out = record(
    "H" +
      r.fileId +
      digits(r.generation, 6) +
      r.status.padEnd(8, " ") +
      text(r.reason ?? "", 20),
  );
  for (const x of r.results)
    out += record(
      "R" + x.reference + x.outcome.padEnd(8, " ") + (x.code ?? "  "),
    );
  return (
    out +
    record(
      "T" +
        digits(r.results.length, 6) +
        digits(r.results.filter((x) => x.outcome === "RETURNED").length, 6),
    )
  );
}

export function parseResponse(content: string): BankResponse {
  const rows = lines(content);
  const header = rows[0],
    trailer = rows.at(-1)!,
    details = rows.slice(1, -1);
  if (
    header[0] !== "H" ||
    trailer[0] !== "T" ||
    details.some((d) => d[0] !== "R")
  )
    throw new EftError(
      "RECORD_LAYOUT",
      "Expected one header, results and one trailer",
    );
  const status = header.slice(43, 51).trimEnd();
  if (
    !UUID.test(header.slice(1, 37)) ||
    (status !== "ACCEPTED" && status !== "REJECTED")
  )
    throw new EftError("HEADER", "Invalid response header");
  const results = details.map((d): BankResult => {
    const outcome = d.slice(37, 45).trimEnd(),
      code = d.slice(45, 47).trim() || null;
    if (
      !UUID.test(d.slice(1, 37)) ||
      !(
        (outcome === "PAID" && code === null) ||
        (outcome === "RETURNED" &&
          code !== null &&
          Object.hasOwn(RETURN_CODES, code))
      )
    )
      throw new EftError("DETAIL", "Invalid response result");
    return {
      reference: d.slice(1, 37),
      outcome: outcome as BankResult["outcome"],
      code,
    };
  });
  if (
    number(trailer.slice(1, 7)) !== BigInt(results.length) ||
    number(trailer.slice(7, 13)) !==
      BigInt(results.filter((x) => x.outcome === "RETURNED").length)
  )
    throw new EftError(
      "TRAILER_COUNT",
      "Response trailer counts differ from results",
    );
  if (status === "REJECTED" && results.length)
    throw new EftError("HEADER", "A rejected file has no item results");
  return {
    fileId: header.slice(1, 37),
    generation: Number(number(header.slice(37, 43))),
    status,
    reason: header.slice(51, 71).trim() || null,
    results,
  };
}
