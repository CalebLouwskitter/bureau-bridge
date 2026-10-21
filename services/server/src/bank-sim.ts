import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  buildResponse,
  EftError,
  parseEft,
  sha256,
  USER_CODE,
  type BankResult,
} from "./eft.ts";

// A stand-in for the receiving bank. It is a separate service with its own
// state, so the payments hub cannot see inside it; it can only submit a file
// and ask for the response to a generation it already sent.
export interface Submission {
  sha256: string;
  response: string;
  receivedAt: string;
}
export interface BankLedger {
  get(key: string): Promise<Submission | undefined>;
  put(key: string, entry: Submission): Promise<void>;
}
export class MemoryLedger implements BankLedger {
  readonly entries = new Map<string, Submission>();
  async get(key: string) {
    return this.entries.get(key);
  }
  async put(key: string, entry: Submission) {
    this.entries.set(key, entry);
  }
}
export class FileLedger implements BankLedger {
  constructor(private path: string) {}
  private async load(): Promise<Record<string, Submission>> {
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (error: any) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }
  async get(key: string) {
    return (await this.load())[key];
  }
  async put(key: string, entry: Submission) {
    const all = { ...(await this.load()), [key]: entry };
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(all, null, 2));
    await rename(temporary, this.path);
  }
}
export class BankInputError extends Error {}

export class BankSimulator {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private ledger: BankLedger,
    // "branch/account" values the fictional bank has closed.
    private closed: Set<string>,
    private userCode = USER_CODE,
  ) {}
  private reject(fileId: string, generation: number, reason: string) {
    return buildResponse({
      fileId,
      generation,
      status: "REJECTED",
      reason,
      results: [],
    });
  }
  // One submission at a time, like a bank's file intake.
  submit(content: string): Promise<string> {
    const run = this.queue.then(() => this.receive(content));
    this.queue = run.catch(() => {});
    return run;
  }
  private async receive(content: string): Promise<string> {
    const head = content.slice(0, 80);
    const fileId = head.slice(23, 59),
      generation = Number(head.slice(9, 15));
    if (head[0] !== "H" || !/^\d{6}$/.test(head.slice(9, 15)))
      throw new BankInputError("Unreadable file header");
    let file;
    try {
      file = parseEft(content);
    } catch (error) {
      if (error instanceof EftError && /^[0-9a-f-]{36}$/.test(fileId))
        return this.reject(fileId, generation, error.code);
      throw new BankInputError("Unreadable file");
    }
    if (file.userCode !== this.userCode)
      return this.reject(file.fileId, file.generation, "UNKNOWN_USER_CODE");
    const key = `${file.userCode}:${file.generation}`,
      hash = sha256(content);
    const previous = await this.ledger.get(key);
    // Resending identical bytes returns the original outcome without paying
    // again. A different file under a used generation is refused outright.
    if (previous)
      return previous.sha256 === hash
        ? previous.response
        : this.reject(file.fileId, file.generation, "DUPLICATE_GENERATION");
    const results = file.items.map(
      (i): BankResult =>
        this.closed.has(`${i.branch}/${i.account}`)
          ? { reference: i.reference, outcome: "RETURNED", code: "AC" }
          : { reference: i.reference, outcome: "PAID", code: null },
    );
    const response = buildResponse({
      fileId: file.fileId,
      generation: file.generation,
      status: "ACCEPTED",
      reason: null,
      results,
    });
    await this.ledger.put(key, {
      sha256: hash,
      response,
      receivedAt: new Date().toISOString(),
    });
    return response;
  }
  async inquire(userCode: string, generation: number) {
    return (await this.ledger.get(`${userCode}:${generation}`))?.response;
  }
}
