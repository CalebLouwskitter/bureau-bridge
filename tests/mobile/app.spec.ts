import { test, expect, type Page } from "@playwright/test";

const SOURCE = "INS000000001",
  EMPLOYEE = "EMP000000001";
const NOW = "2026-10-05T15:00:00.000Z";
const POSTED = "00000000-0000-4000-8000-000000000001";
const VERIFYING = "00000000-0000-4000-8000-000000000002";

async function mockApi(page: Page, loseFirstAcknowledgement = false) {
  let principal = {
    username: "insurer-admin",
    role: "payroll",
    clientId: "insurer-demo",
    employeeAccount: undefined as string | undefined,
  };
  const submissions: { key: string; payload: Record<string, unknown> }[] = [];
  const actions: string[] = [];
  const rows = [
    {
      id: POSTED,
      status: "POSTED",
      postingId: "CORE-ORIGINAL-001",
      targetAccount: EMPLOYEE,
    },
    {
      id: VERIFYING,
      status: "VERIFYING",
      postingId: null,
      targetAccount: "EMP000000002",
    },
  ].map((a) => ({
    ...a,
    sourceAccount: SOURCE,
    amountMinor: 25000,
    currency: "ZAR",
    clientId: "insurer-demo",
    reason: null,
    createdAt: NOW,
    updatedAt: NOW,
  }));
  const report = {
    id: "observation-1",
    clientId: "insurer-demo",
    createdAt: NOW,
    observedAt: NOW,
    generation: "core-1",
    modernCount: 2,
    intakeCount: 2,
    coreCount: 2,
    truncated: false,
    findings: [
      {
        severity: "WARN",
        code: "IMPORT_PENDING",
        reference: VERIFYING,
        details: "Core posted; intake is awaiting its result import.",
      },
    ],
  };

  await page.route("http://localhost:3000/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      method = request.method();
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, Idempotency-Key",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    };
    const reply = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        headers,
        contentType: "application/json",
        body: JSON.stringify(data),
      });
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (url.pathname === "/session") {
      const username = request.postDataJSON().username;
      const role =
        username === "employee-one"
          ? "employee"
          : username === "ops"
            ? "ops"
            : "payroll";
      principal = {
        username,
        role,
        clientId: "insurer-demo",
        employeeAccount: role === "employee" ? EMPLOYEE : undefined,
      };
      return reply({ token: "mock-ui-session", principal });
    }
    if (url.pathname === "/accounts")
      return reply({
        accounts: [SOURCE, EMPLOYEE, "EMP000000002", "EMP000000003"]
          .filter(
            (account) => principal.role !== "employee" || account === EMPLOYEE,
          )
          .map((account) => ({
            account,
            kind: account === SOURCE ? "CLIENT" : "EMPLOYEE",
            amountMinor:
              account === SOURCE
                ? 9950000
                : account === EMPLOYEE || account === "EMP000000002"
                  ? 25000
                  : 0,
            state: account.endsWith("3") ? "SUSPENDED" : "ACTIVE",
            currency: "ZAR",
            generation: "core-1",
            sequence: 1,
            observedAt: NOW,
          })),
      });
    if (url.pathname === "/allocations" && method === "GET")
      return reply({
        allocations: rows.filter(
          (a) => principal.role !== "employee" || a.targetAccount === EMPLOYEE,
        ),
      });
    if (url.pathname === "/allocations" && method === "POST") {
      const key = request.headers()["idempotency-key"],
        payload = request.postDataJSON();
      submissions.push({ key, payload });
      if (loseFirstAcknowledgement && submissions.length === 1)
        return reply({ error: "Acknowledgement unavailable" }, 503);
      if (!rows.some((a) => a.id === key))
        rows.unshift({
          ...rows[0],
          ...payload,
          id: key,
          status: "QUEUED",
          postingId: null,
        });
      return reply({ allocation: rows.find((a) => a.id === key) }, 201);
    }
    if (/\/allocations\/[^/]+\/(inquiry|resume)$/.test(url.pathname)) {
      actions.push(url.pathname);
      return reply({ accepted: true });
    }
    if (/\/allocations\/[^/]+$/.test(url.pathname))
      return reply({
        events: [
          { status: "QUEUED", reason: null, createdAt: NOW },
          { status: "POSTED", reason: "OK", createdAt: NOW },
        ],
      });
    if (url.pathname === "/reconciliation/report.csv")
      return route.fulfill({
        status: 200,
        headers,
        contentType: "text/csv",
        body: "severity,code\nWARN,IMPORT_PENDING\n",
      });
    if (url.pathname === "/reconciliation") {
      if (method === "POST") actions.push("comparison");
      return reply({ run: report });
    }
    return reply({ error: "Unexpected UI API path" }, 404);
  });
  return { submissions, actions };
}

async function signIn(page: Page, username = "insurer-admin") {
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill("ui-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Home tab" })).toBeVisible();
  const title = page.getByRole("heading", { level: 1 });
  await expect(title).toBeVisible();
  await expect
    .poll(() =>
      page.getByTestId("screen-scroll").evaluate((el) => el.scrollTop),
    )
    .toBe(0);
}

test("first launch is light even with a dark OS; manual black/mint choice survives reload", async ({
  page,
}) => {
  await mockApi(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.getByTestId("app-surface")).toHaveCSS(
    "background-color",
    "rgb(244, 247, 245)",
  );
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "type",
    "password",
  );
  await page.getByRole("button", { name: "Show password" }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "type",
    "text",
  );
  await signIn(page);
  await expect(page.getByTestId("balance-hero")).toContainText("99");
  if (process.env.BUREAU_CAPTURE_UI)
    await page.screenshot({ path: "docs/assets/mobile-light.png" });
  await page.getByRole("button", { name: "Use dark appearance" }).click();
  await expect(page.getByTestId("app-surface")).toHaveCSS(
    "background-color",
    "rgb(5, 5, 5)",
  );
  await expect(page.getByTestId("balance-hero")).toHaveCSS(
    "background-color",
    "rgb(141, 228, 189)",
  );
  if (process.env.BUREAU_CAPTURE_UI)
    await page.screenshot({ path: "docs/assets/mobile-dark.png" });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Use light appearance" }),
  ).toBeVisible();
  await expect(page.getByTestId("app-surface")).toHaveCSS(
    "background-color",
    "rgb(5, 5, 5)",
  );
  await page.getByRole("button", { name: "Use light appearance" }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Use dark appearance" }),
  ).toBeVisible();
});

test("failed send and app restart preserve the original immutable allocation", async ({
  page,
}) => {
  const api = await mockApi(page, true);
  await page.goto("/");
  await signIn(page);
  await page.getByRole("tab", { name: "Allocate tab" }).click();
  await page.getByLabel("Amount in rand").fill("1,234");
  await page.getByRole("button", { name: "Submit allocation" }).click();
  await expect(
    page.getByText(
      "Enter rand with at most two decimal places, e.g. 250.00 or 250,00.",
    ),
  ).toBeVisible();
  expect(api.submissions).toHaveLength(0);
  await page.getByLabel("Amount in rand").fill("321,09");
  await page.getByRole("radio", { name: "Employee 2", exact: true }).click();
  await page.getByRole("button", { name: "Submit allocation" }).click();
  await expect(
    page.getByRole("button", { name: "Retry same request" }),
  ).toBeVisible();
  await expect(page.getByLabel("Amount in rand")).toBeDisabled();
  await page.reload();
  await signIn(page);
  await page.getByRole("button", { name: "Resume unfinished request" }).click();
  await expect(page.getByLabel("Amount in rand")).toHaveValue("321.09");
  await expect(
    page.getByRole("radio", { name: "Employee 2", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Retry same request" }).click();
  await expect(page.getByRole("tab", { name: "Activity tab" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(api.submissions).toHaveLength(2);
  expect(api.submissions[1]).toEqual(api.submissions[0]);
  expect(api.submissions[0].payload).toEqual({
    sourceAccount: SOURCE,
    targetAccount: "EMP000000002",
    amountMinor: 32109,
    currency: "ZAR",
  });
});

test("employee sees only own balance/activity and can inspect status history", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");
  await signIn(page, "employee-one");
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("tab", { name: "Allocate tab" })).toHaveCount(0);
  await expect(page.getByText("Employer prefunded balance")).toHaveCount(0);
  await expect(page.getByText("Employee 2", { exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Activity tab" }).click();
  await page.getByRole("button", { name: "View status history" }).click();
  await expect(
    page.getByRole("button", { name: "Hide history" }),
  ).toBeVisible();
  await expect(
    page.getByText("CORE-ORIGINAL-001", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Run core inquiry" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
});

test("operations retains core inquiry, verified resumption, comparison and CSV download", async ({
  page,
}) => {
  const api = await mockApi(page);
  await page.goto("/");
  await signIn(page, "ops");
  await expect(page.getByRole("tab")).toHaveCount(4);
  await page.getByRole("tab", { name: "Activity tab" }).click();
  await page.getByRole("button", { name: "Run core inquiry" }).nth(1).click();
  await page.getByRole("button", { name: "Verify and resume" }).click();
  expect(api.actions).toEqual([
    `/allocations/${VERIFYING}/inquiry`,
    `/allocations/${VERIFYING}/resume`,
  ]);
  await page.getByRole("tab", { name: "Ops tab" }).click();
  await page.getByRole("button", { name: "Run comparison" }).click();
  await expect(
    page.getByText("Reconciliation observation saved."),
  ).toBeVisible();
  expect(api.actions).toContain("comparison");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  expect((await download).suggestedFilename()).toBe("reconciliation.csv");
});

test("narrow phone layout has visible controls, no horizontal overflow and no runtime errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockApi(page);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  await signIn(page, "ops");
  for (const name of ["Home tab", "Allocate tab", "Activity tab", "Ops tab"]) {
    await page.getByRole("tab", { name }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const bounds = await page.getByRole("tab", { name }).boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
  }
  await page.getByRole("button", { name: "Use dark appearance" }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
