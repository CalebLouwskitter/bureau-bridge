import { UUID } from "@bureau/contracts";
import {
  EftError,
  MAX_ITEMS,
  RETURN_CODES,
  type BankResponse,
  type BankResult,
  type EftFile,
  type EftItem,
  type PaymentRailFormatter,
} from "./eft.ts";

export const PAIN_001_NAMESPACE =
  "urn:iso:std:iso:20022:tech:xsd:pain.001.001.09";
export const PAIN_002_NAMESPACE =
  "urn:iso:std:iso:20022:tech:xsd:pain.002.001.10";

// Mapping between BureauBridge return codes and ISO 20022 ExternalStatusReason1Code.
const RETURN_TO_ISO_REASON: Record<string, string> = {
  AC: "AC04", // ClosedAccountNumber
  NA: "AC01", // IncorrectAccountNumber
  AF: "AC06", // BlockedAccount
};
const ISO_REASON_TO_RETURN: Record<string, string> = {
  AC04: "AC",
  AC01: "NA",
  AC06: "AF",
  AC: "AC",
  NA: "NA",
  AF: "AF",
};

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlUnescape(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function formatMinorZar(amountMinor: number | bigint): string {
  const minor = typeof amountMinor === "bigint" ? amountMinor : BigInt(amountMinor);
  if (minor < 1n) {
    throw new EftError("DETAIL", "Amount must be positive minor units");
  }
  const whole = minor / 100n;
  const cents = (minor % 100n).toString().padStart(2, "0");
  return `${whole.toString()}.${cents}`;
}

function parseZarToMinor(decimalText: string, code = "DETAIL"): number {
  const trimmed = decimalText.trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) {
    throw new EftError(code, `Invalid ZAR decimal amount: ${decimalText}`);
  }
  const whole = BigInt(match[1]);
  const frac = BigInt((match[2] ?? "").padEnd(2, "0"));
  const minor = whole * 100n + frac;
  if (minor < 1n || minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new EftError(code, `Amount out of range: ${decimalText}`);
  }
  return Number(minor);
}

function extractTag(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`);
  const match = re.exec(xml);
  return match ? xmlUnescape(match[1].trim()) : undefined;
}

function extractAllBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "g");
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

export function buildPain001(file: EftFile): string {
  if (!file.items.length || file.items.length > MAX_ITEMS) {
    throw new EftError("ITEM_COUNT", `A file holds 1 to ${MAX_ITEMS} items`);
  }
  if (!UUID.test(file.fileId) || !/^\d{4}-\d{2}-\d{2}$/.test(file.actionDate)) {
    throw new EftError("HEADER", "Invalid file identifier or action date");
  }
  if (
    !Number.isSafeInteger(file.generation) ||
    file.generation < 1 ||
    file.generation > 999_999
  ) {
    throw new EftError("HEADER", "Invalid file generation");
  }
  if (!/^[A-Z0-9 _]{1,35}$/.test(file.userCode)) {
    throw new EftError("HEADER", "Invalid initiating party user code");
  }

  const items = [...file.items].sort((a, b) =>
    a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0,
  );
  if (new Set(items.map((i) => i.reference)).size !== items.length) {
    throw new EftError(
      "DUPLICATE_ITEM",
      "A reference may appear once per file",
    );
  }

  let totalMinor = 0n;
  for (const i of items) {
    if (
      !UUID.test(i.reference) ||
      !Number.isSafeInteger(i.amountMinor) ||
      i.amountMinor < 1 ||
      !/^\d{6}$/.test(i.branch) ||
      !/^\d{11}$/.test(i.account)
    ) {
      throw new EftError(
        "DETAIL",
        "Invalid item reference, amount or bank details",
      );
    }
    totalMinor += BigInt(i.amountMinor);
  }

  const genPadded = String(file.generation).padStart(6, "0");
  const ctrlSum = formatMinorZar(totalMinor);
  const pmtInfId = `${file.userCode}-${genPadded}`;
  const creDtTm = `${file.actionDate}T00:00:00Z`;

  const txXml = items
    .map(
      (i) =>
        `      <CdtTrfTxInf>\n` +
        `        <PmtId>\n` +
        `          <InstrId>${xmlEscape(i.reference)}</InstrId>\n` +
        `          <EndToEndId>${xmlEscape(i.reference)}</EndToEndId>\n` +
        `        </PmtId>\n` +
        `        <Amt>\n` +
        `          <InstdAmt Ccy="ZAR">${formatMinorZar(i.amountMinor)}</InstdAmt>\n` +
        `        </Amt>\n` +
        `        <CdtrAgt>\n` +
        `          <FinInstnId>\n` +
        `            <ClrSysMmbId>\n` +
        `              <ClrSysId><Cd>ZAC</Cd></ClrSysId>\n` +
        `              <MmbId>${xmlEscape(i.branch)}</MmbId>\n` +
        `            </ClrSysMmbId>\n` +
        `          </FinInstnId>\n` +
        `        </CdtrAgt>\n` +
        `        <Cdtr>\n` +
        `          <Nm>${xmlEscape(i.holder)}</Nm>\n` +
        `        </Cdtr>\n` +
        `        <CdtrAcct>\n` +
        `          <Id><Othr><Id>${xmlEscape(i.account)}</Id></Othr></Id>\n` +
        `          <Ccy>ZAR</Ccy>\n` +
        `        </CdtrAcct>\n` +
        `        <RmtInf>\n` +
        `          <Ustrd>${xmlEscape(i.reference)}</Ustrd>\n` +
        `        </RmtInf>\n` +
        `      </CdtTrfTxInf>`,
    )
    .join("\n");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Document xmlns="${PAIN_001_NAMESPACE}">\n` +
    `  <CstmrCdtTrfInitn>\n` +
    `    <GrpHdr>\n` +
    `      <MsgId>${xmlEscape(file.fileId)}</MsgId>\n` +
    `      <CreDtTm>${creDtTm}</CreDtTm>\n` +
    `      <NbOfTxs>${items.length}</NbOfTxs>\n` +
    `      <CtrlSum>${ctrlSum}</CtrlSum>\n` +
    `      <InitgPty>\n` +
    `        <Nm>${xmlEscape(file.userCode)}</Nm>\n` +
    `        <Id><OrgId><Othr><Id>${xmlEscape(file.userCode)}</Id><SchmeNm><Prtry>GEN:${genPadded}</Prtry></SchmeNm></Othr></OrgId></Id>\n` +
    `      </InitgPty>\n` +
    `    </GrpHdr>\n` +
    `    <PmtInf>\n` +
    `      <PmtInfId>${xmlEscape(pmtInfId)}</PmtInfId>\n` +
    `      <PmtMtd>TRF</PmtMtd>\n` +
    `      <BtchBookg>true</BtchBookg>\n` +
    `      <NbOfTxs>${items.length}</NbOfTxs>\n` +
    `      <CtrlSum>${ctrlSum}</CtrlSum>\n` +
    `      <PmtTpInf>\n` +
    `        <SvcLvl><Cd>NURG</Cd></SvcLvl>\n` +
    `        <LclInstrm><Prtry>EFT_CR</Prtry></LclInstrm>\n` +
    `      </PmtTpInf>\n` +
    `      <ReqdExctnDt><Dt>${file.actionDate}</Dt></ReqdExctnDt>\n` +
    `      <Dbtr><Nm>${xmlEscape(file.userCode)}</Nm></Dbtr>\n` +
    `      <DbtrAcct><Id><Othr><Id>${xmlEscape(file.userCode)}SETTLE</Id></Othr></Id><Ccy>ZAR</Ccy></DbtrAcct>\n` +
    `      <DbtrAgt><FinInstnId><ClrSysMmbId><ClrSysId><Cd>ZAC</Cd></ClrSysId><MmbId>000001</MmbId></ClrSysMmbId></FinInstnId></DbtrAgt>\n` +
    `${txXml}\n` +
    `    </PmtInf>\n` +
    `  </CstmrCdtTrfInitn>\n` +
    `</Document>\n`
  );
}

export function parsePain001(content: string): EftFile {
  if (!content.includes(PAIN_001_NAMESPACE)) {
    throw new EftError(
      "RECORD_LAYOUT",
      `Expected ISO 20022 ${PAIN_001_NAMESPACE} document`,
    );
  }
  const grpHdr = extractTag(content, "GrpHdr");
  const pmtInf = extractTag(content, "PmtInf");
  if (!grpHdr || !pmtInf) {
    throw new EftError("HEADER", "Missing GrpHdr or PmtInf in pain.001");
  }

  const fileId = extractTag(grpHdr, "MsgId") ?? "";
  if (!UUID.test(fileId)) {
    throw new EftError("HEADER", "Invalid pain.001 MsgId");
  }
  const initgPty = extractTag(grpHdr, "InitgPty") ?? "";
  const userCode = extractTag(initgPty, "Nm") ?? "";
  if (!userCode) {
    throw new EftError("HEADER", "Missing InitgPty Nm in pain.001");
  }
  const genPrtry = extractTag(initgPty, "Prtry") ?? "";
  const pmtInfId = extractTag(pmtInf, "PmtInfId") ?? "";
  const genMatch =
    /^GEN:(\d{1,6})$/.exec(genPrtry) ?? /-(\d{1,6})$/.exec(pmtInfId);
  if (!genMatch) {
    throw new EftError("HEADER", "Missing file generation in pain.001");
  }
  const generation = Number(genMatch[1]);

  const reqdDtBlock = extractTag(pmtInf, "ReqdExctnDt") ?? "";
  const actionDate = extractTag(reqdDtBlock, "Dt") ?? reqdDtBlock;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(actionDate)) {
    throw new EftError("HEADER", "Invalid ReqdExctnDt in pain.001");
  }

  const txBlocks = extractAllBlocks(pmtInf, "CdtTrfTxInf");
  if (!txBlocks.length) {
    throw new EftError("ITEM_COUNT", "pain.001 must contain at least one transaction");
  }

  const items: EftItem[] = txBlocks.map((tx) => {
    const pmtId = extractTag(tx, "PmtId") ?? "";
    const reference = extractTag(pmtId, "EndToEndId") ?? "";
    if (!UUID.test(reference)) {
      throw new EftError("DETAIL", "Invalid EndToEndId in pain.001");
    }
    const amtMatch = /<InstdAmt\s+Ccy="([A-Z]{3})"[^>]*>([^<]+)<\/InstdAmt>/.exec(
      tx,
    );
    if (!amtMatch || amtMatch[1] !== "ZAR") {
      throw new EftError("DETAIL", "Expected ZAR InstdAmt in pain.001");
    }
    const amountMinor = parseZarToMinor(amtMatch[2], "DETAIL");
    const cdtrAgt = extractTag(tx, "CdtrAgt") ?? "";
    const branch = extractTag(cdtrAgt, "MmbId") ?? "";
    const cdtr = extractTag(tx, "Cdtr") ?? "";
    const holder = extractTag(cdtr, "Nm") ?? "";
    const cdtrAcct = extractTag(tx, "CdtrAcct") ?? "";
    const account = extractTag(cdtrAcct, "Id")
      ? (extractTag(extractTag(cdtrAcct, "Othr") ?? "", "Id") ?? "")
      : "";
    if (!/^\d{6}$/.test(branch) || !/^\d{11}$/.test(account)) {
      throw new EftError("DETAIL", "Invalid creditor branch or account in pain.001");
    }
    return { reference, branch, account, amountMinor, holder };
  });

  if (new Set(items.map((i) => i.reference)).size !== items.length) {
    throw new EftError("DUPLICATE_ITEM", "Duplicate EndToEndId in pain.001");
  }

  const grpCount = Number(extractTag(grpHdr, "NbOfTxs"));
  const pmtCount = Number(extractTag(pmtInf, "NbOfTxs"));
  if (grpCount !== items.length || pmtCount !== items.length) {
    throw new EftError(
      "TRAILER_COUNT",
      "pain.001 NbOfTxs does not match transaction count",
    );
  }

  const actualTotal = items.reduce((sum, i) => sum + i.amountMinor, 0);
  const grpSumText = extractTag(grpHdr, "CtrlSum");
  const pmtSumText = extractTag(pmtInf, "CtrlSum");
  if (
    !grpSumText ||
    !pmtSumText ||
    parseZarToMinor(grpSumText, "TRAILER_AMOUNT") !== actualTotal ||
    parseZarToMinor(pmtSumText, "TRAILER_AMOUNT") !== actualTotal
  ) {
    throw new EftError(
      "TRAILER_AMOUNT",
      "pain.001 CtrlSum does not match sum of transactions",
    );
  }

  return {
    userCode,
    fileId,
    generation,
    actionDate,
    items,
  };
}

export function buildPain002(response: BankResponse): string {
  if (!UUID.test(response.fileId)) {
    throw new EftError("HEADER", "Invalid file identifier");
  }
  if (response.status === "REJECTED" && response.results.length > 0) {
    throw new EftError("HEADER", "A rejected file has no item results");
  }
  const hasReturned = response.results.some((r) => r.outcome === "RETURNED");
  const grpSts =
    response.status === "REJECTED"
      ? "RJCT"
      : hasReturned
        ? "PART"
        : "ACSC";
  const genPadded = String(response.generation).padStart(6, "0");

  const grpReasonXml =
    response.status === "REJECTED" && response.reason
      ? `      <StsRsnInf><Rsn><Prtry>${xmlEscape(response.reason)}</Prtry></Rsn></StsRsnInf>\n`
      : "";

  const txXml = response.results
    .map((r) => {
      if (r.outcome === "PAID") {
        return (
          `      <TxInfAndSts>\n` +
          `        <OrgnlEndToEndId>${xmlEscape(r.reference)}</OrgnlEndToEndId>\n` +
          `        <TxSts>ACSC</TxSts>\n` +
          `      </TxInfAndSts>`
        );
      }
      if (!r.code || !Object.hasOwn(RETURN_CODES, r.code)) {
        throw new EftError("DETAIL", `Unsupported return code: ${r.code}`);
      }
      const isoCode = RETURN_TO_ISO_REASON[r.code] ?? r.code;
      return (
        `      <TxInfAndSts>\n` +
        `        <OrgnlEndToEndId>${xmlEscape(r.reference)}</OrgnlEndToEndId>\n` +
        `        <TxSts>RJCT</TxSts>\n` +
        `        <StsRsnInf><Rsn><Cd>${xmlEscape(isoCode)}</Cd></Rsn></StsRsnInf>\n` +
        `      </TxInfAndSts>`
      );
    })
    .join("\n");

  const pmtBlock =
    response.results.length > 0
      ? `    <OrgnlPmtInfAndSts>\n` +
        `      <OrgnlPmtInfId>GEN-${genPadded}</OrgnlPmtInfId>\n` +
        `      <OrgnlNbOfTxs>${response.results.length}</OrgnlNbOfTxs>\n` +
        `${txXml}\n` +
        `    </OrgnlPmtInfAndSts>\n`
      : "";

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Document xmlns="${PAIN_002_NAMESPACE}">\n` +
    `  <CstmrPmtStsRpt>\n` +
    `    <GrpHdr>\n` +
    `      <MsgId>PSR-${xmlEscape(response.fileId)}</MsgId>\n` +
    `      <CreDtTm>1970-01-01T00:00:00Z</CreDtTm>\n` +
    `    </GrpHdr>\n` +
    `    <OrgnlGrpInfAndSts>\n` +
    `      <OrgnlMsgId>${xmlEscape(response.fileId)}</OrgnlMsgId>\n` +
    `      <OrgnlMsgNmId>pain.001.001.09</OrgnlMsgNmId>\n` +
    `      <OrgnlNbOfTxs>${response.results.length}</OrgnlNbOfTxs>\n` +
    `      <GrpSts>${grpSts}</GrpSts>\n` +
    `      <StsRsnInf><AddtlInf>GEN:${genPadded}</AddtlInf></StsRsnInf>\n` +
    `${grpReasonXml}` +
    `    </OrgnlGrpInfAndSts>\n` +
    `${pmtBlock}` +
    `  </CstmrPmtStsRpt>\n` +
    `</Document>\n`
  );
}

export function parsePain002(content: string): BankResponse {
  if (!/urn:iso:std:iso:20022:tech:xsd:pain\.002\.001\.\d{2}/.test(content)) {
    throw new EftError(
      "RECORD_LAYOUT",
      "Expected ISO 20022 pain.002 CustomerPaymentStatusReport document",
    );
  }
  const orgnlGrp = extractTag(content, "OrgnlGrpInfAndSts");
  if (!orgnlGrp) {
    throw new EftError("HEADER", "Missing OrgnlGrpInfAndSts in pain.002");
  }
  const fileId = extractTag(orgnlGrp, "OrgnlMsgId") ?? "";
  if (!UUID.test(fileId)) {
    throw new EftError("HEADER", "Invalid OrgnlMsgId in pain.002");
  }
  const grpSts = extractTag(orgnlGrp, "GrpSts") ?? "";
  let status: "ACCEPTED" | "REJECTED";
  if (["ACCP", "ACSC", "ACSP", "ACCC", "PART"].includes(grpSts)) {
    status = "ACCEPTED";
  } else if (grpSts === "RJCT") {
    status = "REJECTED";
  } else {
    throw new EftError("HEADER", `Unsupported pain.002 GrpSts: ${grpSts}`);
  }

  const orgnlPmt = extractTag(content, "OrgnlPmtInfAndSts") ?? "";
  const genMatch =
    /GEN:(\d{1,6})/.exec(orgnlGrp) ??
    /GEN-(\d{1,6})/.exec(orgnlPmt) ??
    /-(\d{1,6})$/.exec(extractTag(orgnlPmt, "OrgnlPmtInfId") ?? "");
  if (!genMatch) {
    throw new EftError("HEADER", "Missing generation number in pain.002");
  }
  const generation = Number(genMatch[1]);

  let reason: string | null = null;
  if (status === "REJECTED") {
    const rsnBlock = extractTag(orgnlGrp, "Rsn") ?? "";
    reason =
      extractTag(rsnBlock, "Prtry") ?? extractTag(rsnBlock, "Cd") ?? null;
  }

  const txBlocks = extractAllBlocks(content, "TxInfAndSts");
  if (status === "REJECTED" && txBlocks.length > 0) {
    throw new EftError("HEADER", "A rejected pain.002 file has no item results");
  }

  const results: BankResult[] = txBlocks.map((tx) => {
    const reference = extractTag(tx, "OrgnlEndToEndId") ?? "";
    const txSts = extractTag(tx, "TxSts") ?? "";
    if (!UUID.test(reference)) {
      throw new EftError("DETAIL", "Invalid OrgnlEndToEndId in pain.002");
    }
    if (["ACSC", "ACSP", "ACCC", "ACCP"].includes(txSts)) {
      return { reference, outcome: "PAID", code: null };
    }
    if (txSts === "RJCT") {
      const rsn = extractTag(tx, "Rsn") ?? "";
      const rawCode = extractTag(rsn, "Cd") ?? extractTag(rsn, "Prtry") ?? "";
      const mapped = ISO_REASON_TO_RETURN[rawCode];
      if (!mapped || !Object.hasOwn(RETURN_CODES, mapped)) {
        throw new EftError(
          "DETAIL",
          `Unsupported pain.002 rejection reason code: ${rawCode}`,
        );
      }
      return { reference, outcome: "RETURNED", code: mapped };
    }
    throw new EftError("DETAIL", `Unsupported pain.002 TxSts: ${txSts}`);
  });

  const declaredCountRaw = extractTag(orgnlGrp, "OrgnlNbOfTxs");
  if (declaredCountRaw !== undefined && Number(declaredCountRaw) !== results.length) {
    throw new EftError(
      "TRAILER_COUNT",
      "pain.002 OrgnlNbOfTxs differs from transaction statuses",
    );
  }

  return {
    fileId,
    generation,
    status,
    reason,
    results,
  };
}

export class Iso20022PainFormatter implements PaymentRailFormatter {
  readonly format = "ISO20022_PAIN001" as const;
  readonly contentType = "application/xml; charset=utf-8";
  readonly fileExtension = "xml";

  buildPaymentFile(file: EftFile): string {
    return buildPain001(file);
  }

  parsePaymentFile(content: string): EftFile {
    return parsePain001(content);
  }

  buildStatusResponse(response: BankResponse): string {
    return buildPain002(response);
  }

  parseStatusResponse(content: string): BankResponse {
    return parsePain002(content);
  }
}
