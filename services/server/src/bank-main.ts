import Fastify from "fastify";
import { env } from "./config.ts";
import { equal } from "./auth.ts";
import { BankInputError, BankSimulator, FileLedger } from "./bank-sim.ts";

const key = env("BANK_KEY");
const bank = new BankSimulator(
  new FileLedger(env("BANK_STATE", "/data/bank/submissions.json")),
  new Set(
    env("BANK_CLOSED_ACCOUNTS", "990002/20000000025")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ),
);
// Lab fault injection: process the next file, then withhold its response.
let dropNextResponse = false;
const app = Fastify({ logger: true, bodyLimit: 1_000_000 });
app.addHook("onRequest", async (request, reply) => {
  if (request.url === "/health") return;
  if (!equal(request.headers.authorization ?? "", `Bearer ${key}`))
    return reply.code(401).send({ error: "Unauthorized" });
});
app.get("/health", async () => ({ status: "ok", service: "demo-bank" }));
app.post("/files", async (request, reply) => {
  if (typeof request.body !== "string")
    return reply.code(415).send({ error: "Send the file as text/plain" });
  try {
    const response = await bank.submit(request.body);
    if (dropNextResponse) {
      dropNextResponse = false;
      return reply.code(504).send({ error: "Injected lost bank response" });
    }
    return reply.type("text/plain; charset=utf-8").send(response);
  } catch (error) {
    if (error instanceof BankInputError)
      return reply.code(400).send({ error: error.message });
    throw error;
  }
});
app.get<{ Params: { userCode: string; generation: string } }>(
  "/files/:userCode/:generation/response",
  async (request, reply) => {
    const generation = Number(request.params.generation);
    if (!Number.isSafeInteger(generation))
      return reply.code(400).send({ error: "Invalid generation" });
    const response = await bank.inquire(request.params.userCode, generation);
    if (!response) return reply.code(404).send({ error: "Unknown file" });
    return reply.type("text/plain; charset=utf-8").send(response);
  },
);
app.post("/faults", async (request) => {
  dropNextResponse = Boolean(
    (request.body as { dropNextResponse?: unknown } | null)?.dropNextResponse,
  );
  return { dropNextResponse };
});
process.once("SIGTERM", () => void app.close());
process.once("SIGINT", () => void app.close());
await app.listen({ host: "0.0.0.0", port: Number(env("PORT", "3100")) });
