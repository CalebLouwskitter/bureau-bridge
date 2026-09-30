import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { parseAllocation, UUID, type Principal } from "@bureau/contracts";
import { Conflict, type Store } from "./store.ts";
import type { Legacy } from "./legacy.ts";
import { equal, issue, verify } from "./auth.ts";
import { reconcile, reportCsv } from "./reconciliation.ts";
declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}
export function makeApp(
  store: Store,
  legacy: Legacy,
  options: {
    sessionSecret: string;
    demoPassword: string;
    origins?: string[];
    health?: () => Promise<void>;
    logger?: boolean;
  },
) {
  const app = Fastify({
    bodyLimit: 8192,
    logger: options.logger
      ? { redact: ["req.headers.authorization", "req.body.password"] }
      : false,
  });
  app.register(cors, {
    origin: options.origins ?? ["http://localhost:8081"],
    credentials: false,
  });
  app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.addHook("onRequest", async (request, reply) => {
    if (
      request.method === "OPTIONS" ||
      ["/health", "/session"].includes(request.url.split("?")[0])
    )
      return;
    const header = request.headers.authorization ?? "";
    const principal = header.startsWith("Bearer ")
      ? verify(header.slice(7), options.sessionSecret)
      : undefined;
    if (!principal)
      return reply.code(401).send({ error: "Sign in to continue" });
    request.principal = principal;
  });
  app.get("/health", async () => {
    await options.health?.();
    return { status: "ok", service: "bureau-api" };
  });
  app.post(
    "/session",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = request.body as {
        username?: unknown;
        password?: unknown;
      } | null;
      if (
        !body ||
        typeof body.username !== "string" ||
        typeof body.password !== "string" ||
        !equal(body.password, options.demoPassword)
      )
        return reply.code(401).send({ error: "Invalid demo credentials" });
      const token = issue(body.username, options.sessionSecret);
      if (!token)
        return reply.code(401).send({ error: "Invalid demo credentials" });
      return {
        token,
        principal: verify(token, options.sessionSecret),
        expiresIn: 3600,
      };
    },
  );
  app.get("/allocations", async (request) => {
    const p = request.principal!;
    return { allocations: await store.list(p.clientId, p.employeeAccount) };
  });
  app.get("/accounts", async (request) => {
    const p = request.principal!;
    return { accounts: await store.accounts(p.clientId, p.employeeAccount) };
  });
  app.get("/reconciliation", async (request, reply) => {
    if (request.principal!.role !== "ops")
      return reply.code(403).send({ error: "Operations role required" });
    return {
      run:
        (await store.latestReconciliation(request.principal!.clientId)) ?? null,
    };
  });
  app.post("/reconciliation", async (request, reply) => {
    if (request.principal!.role !== "ops")
      return reply.code(403).send({ error: "Operations role required" });
    return { run: await reconcile(store, legacy, request.principal!.clientId) };
  });
  app.get("/reconciliation/report.csv", async (request, reply) => {
    if (request.principal!.role !== "ops")
      return reply.code(403).send({ error: "Operations role required" });
    const run = await store.latestReconciliation(request.principal!.clientId);
    if (!run)
      return reply.code(404).send({ error: "Run reconciliation first" });
    return reply
      .type("text/csv; charset=utf-8")
      .header(
        "Content-Disposition",
        'attachment; filename="reconciliation.csv"',
      )
      .send(reportCsv(run));
  });
  app.post("/allocations", async (request, reply) => {
    const p = request.principal!;
    if (p.role === "employee")
      return reply.code(403).send({ error: "Payroll role required" });
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !UUID.test(key))
      return reply
        .code(400)
        .send({ error: "Supply a UUID Idempotency-Key header" });
    let input;
    try {
      input = parseAllocation(request.body);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
    try {
      const allocation = await store.create(p.clientId, key, input);
      return reply.code(202).send(allocation);
    } catch (error) {
      if (error instanceof Conflict)
        return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
  app.get<{ Params: { id: string } }>(
    "/allocations/:id",
    async (request, reply) => {
      const a = UUID.test(request.params.id)
        ? await store.get(request.params.id)
        : undefined;
      const p = request.principal!;
      if (
        !a ||
        a.clientId !== p.clientId ||
        (p.employeeAccount && a.targetAccount !== p.employeeAccount)
      )
        return reply.code(404).send({ error: "Allocation not found" });
      return { ...a, events: await store.events(a.id) };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/allocations/:id/inquiry",
    async (request, reply) => {
      const p = request.principal!;
      if (p.role !== "ops")
        return reply.code(403).send({ error: "Operations role required" });
      const a = UUID.test(request.params.id)
        ? await store.get(request.params.id)
        : undefined;
      if (!a || a.clientId !== p.clientId)
        return reply.code(404).send({ error: "Allocation not found" });
      const result = await legacy.inquire(a.id);
      if (!result)
        return reply
          .code(409)
          .send({ error: "Legacy intake has no matching reference" });
      if (!["POSTED", "DECLINED"].includes(a.status)) await store.wake(a.id);
      return { status: "INQUIRY_COMPLETED", result };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/allocations/:id/resume",
    async (request, reply) => {
      const p = request.principal!;
      if (p.role !== "ops")
        return reply.code(403).send({ error: "Operations role required" });
      const a = UUID.test(request.params.id)
        ? await store.get(request.params.id)
        : undefined;
      if (!a || a.clientId !== p.clientId)
        return reply.code(404).send({ error: "Allocation not found" });
      if (["POSTED", "DECLINED"].includes(a.status))
        return reply
          .code(409)
          .send({ error: "Allocation already has a final outcome" });
      // A missing intake can be delivered using its original reference. A known
      // intake must be checked against the core before it re-enters a batch.
      if (await legacy.lookup(a.id)) await legacy.retryUnposted(a.id);
      await store.wake(a.id);
      return { status: "RESUMED_WITH_ORIGINAL_REFERENCE" };
    },
  );
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "Request failed");
    const code = (error as { statusCode?: number }).statusCode;
    reply.code(code && code >= 400 && code < 500 ? code : 503).send({
      error:
        code === 429 ? "Too many requests" : "Service temporarily unavailable",
    });
  });
  return app;
}
