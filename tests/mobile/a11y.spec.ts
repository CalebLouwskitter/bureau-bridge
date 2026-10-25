import { test, expect, type Page, type Locator } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const SOURCE = "INS000000001",
  EMPLOYEE = "EMP000000001";
const NOW = "2026-10-05T15:00:00.000Z";
const POSTED = "00000000-0000-4000-8000-000000000001";
const VERIFYING = "00000000-0000-4000-8000-000000000002";

async function mockApi(page: Page) {
  let principal = {
    username: "insurer-admin",
    role: "payroll",
    clientId: "insurer-demo",
    employeeAccount: undefined as string | undefined,
  };
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
    if (url.pathname === "/accounts") {
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
    }
    if (url.pathname === "/allocations" && method === "GET") {
      return reply({
        allocations: rows.filter(
          (a) => principal.role !== "employee" || a.targetAccount === EMPLOYEE,
        ),
      });
    }
    if (/\/allocations\/[^/]+$/.test(url.pathname)) {
      return reply({
        events: [
          { status: "QUEUED", reason: null, createdAt: NOW },
          { status: "POSTED", reason: "OK", createdAt: NOW },
        ],
      });
    }
    if (url.pathname === "/reconciliation") {
      return reply({ run: report });
    }
    return reply({ error: "Unexpected UI API path" }, 404);
  });
}

async function assertNoAxeViolations(page: Page, contextName: string) {
  const results = await new AxeBuilder({ page }).analyze();
  const criticalOrSerious = results.violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );
  expect(
    criticalOrSerious,
    `Serious or critical axe violations in ${contextName}: ${JSON.stringify(criticalOrSerious, null, 2)}`,
  ).toEqual([]);
}

async function assertEveryPressableHasRoleAndName(
  page: Page,
  contextName: string,
) {
  const pressables: Locator[] = await page
    .locator('button, [role="button"], [role="tab"], [role="radio"]')
    .all();
  expect(
    pressables.length,
    `Expected interactive pressables in ${contextName}`,
  ).toBeGreaterThan(0);

  for (const pressable of pressables) {
    const details = await pressable.evaluate((node) => {
      const explicitRole = node.getAttribute("role");
      const tag = node.tagName.toLowerCase();
      const role = explicitRole || (tag === "button" ? "button" : null);
      const ariaLabel = node.getAttribute("aria-label");
      const innerText = (node as HTMLElement).innerText?.trim();
      const title = node.getAttribute("title");
      const name = ariaLabel || innerText || title || "";
      return {
        role,
        name,
        html: node.outerHTML.slice(0, 100),
      };
    });

    expect(
      details.role,
      `Pressable missing role in ${contextName}: ${details.html}`,
    ).toBeTruthy();
    expect(
      details.name.length,
      `Pressable missing accessible name in ${contextName}: ${details.html}`,
    ).toBeGreaterThan(0);
    await expect(pressable).toHaveAccessibleName(/.+/);
  }
}

async function signIn(page: Page, username = "insurer-admin") {
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill("ui-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Home tab" })).toBeVisible();
}

test.describe("Automated Accessibility (WCAG 2.2 AA)", () => {
  test("Sign-in view passes axe and all pressables have roles and names in both themes", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/");
    await expect(page.getByTestId("app-surface")).toBeVisible();

    // Light mode
    await assertNoAxeViolations(page, "Sign In (Light)");
    await assertEveryPressableHasRoleAndName(page, "Sign In (Light)");

    // Dark mode
    await page.getByRole("button", { name: "Use dark appearance" }).click();
    await assertNoAxeViolations(page, "Sign In (Dark)");
    await assertEveryPressableHasRoleAndName(page, "Sign In (Dark)");
  });

  test("Payroll views (Home, Allocate, Activity) pass axe and have accessible pressables in both themes", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/");
    await signIn(page, "insurer-admin");

    // Home view (Light)
    await assertNoAxeViolations(page, "Home - Payroll (Light)");
    await assertEveryPressableHasRoleAndName(page, "Home - Payroll (Light)");

    // Home view (Dark)
    await page.getByRole("button", { name: "Use dark appearance" }).click();
    await assertNoAxeViolations(page, "Home - Payroll (Dark)");
    await assertEveryPressableHasRoleAndName(page, "Home - Payroll (Dark)");

    // Allocate view (Dark)
    await page.getByRole("tab", { name: "Allocate tab" }).click();
    await assertNoAxeViolations(page, "Allocate (Dark)");
    await assertEveryPressableHasRoleAndName(page, "Allocate (Dark)");

    // Allocate view (Light)
    await page.getByRole("button", { name: "Use light appearance" }).click();
    await assertNoAxeViolations(page, "Allocate (Light)");
    await assertEveryPressableHasRoleAndName(page, "Allocate (Light)");

    // Activity view (Light)
    await page.getByRole("tab", { name: "Activity tab" }).click();
    await assertNoAxeViolations(page, "Activity (Light)");
    await assertEveryPressableHasRoleAndName(page, "Activity (Light)");

    // Activity with expanded history (Light)
    await page.getByRole("button", { name: "View status history" }).first().click();
    await assertNoAxeViolations(page, "Activity History (Light)");
    await assertEveryPressableHasRoleAndName(page, "Activity History (Light)");

    // Activity view (Dark)
    await page.getByRole("button", { name: "Use dark appearance" }).click();
    await assertNoAxeViolations(page, "Activity History (Dark)");
    await assertEveryPressableHasRoleAndName(page, "Activity History (Dark)");
  });

  test("Employee views pass axe and have accessible pressables in both themes", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/");
    await signIn(page, "employee-one");

    // Employee Home (Light)
    await assertNoAxeViolations(page, "Employee Home (Light)");
    await assertEveryPressableHasRoleAndName(page, "Employee Home (Light)");

    // Employee Activity (Light)
    await page.getByRole("tab", { name: "Activity tab" }).click();
    await assertNoAxeViolations(page, "Employee Activity (Light)");
    await assertEveryPressableHasRoleAndName(page, "Employee Activity (Light)");

    // Employee Activity (Dark)
    await page.getByRole("button", { name: "Use dark appearance" }).click();
    await assertNoAxeViolations(page, "Employee Activity (Dark)");
    await assertEveryPressableHasRoleAndName(page, "Employee Activity (Dark)");
  });

  test("Operations views pass axe and have accessible pressables in both themes", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/");
    await signIn(page, "ops");

    // Ops tab (Light)
    await page.getByRole("tab", { name: "Ops tab" }).click();
    await assertNoAxeViolations(page, "Ops (Light)");
    await assertEveryPressableHasRoleAndName(page, "Ops (Light)");

    // Run reconciliation comparison to populate report
    await page.getByRole("button", { name: "Run comparison" }).click();
    await expect(
      page.getByText("Reconciliation observation saved."),
    ).toBeVisible();

    await assertNoAxeViolations(page, "Ops with Observation (Light)");
    await assertEveryPressableHasRoleAndName(page, "Ops with Observation (Light)");

    // Ops with report (Dark)
    await page.getByRole("button", { name: "Use dark appearance" }).click();
    await assertNoAxeViolations(page, "Ops with Observation (Dark)");
    await assertEveryPressableHasRoleAndName(page, "Ops with Observation (Dark)");
  });
});
