import React, { useState } from "react";
import { Button, Input, Text, XStack, YStack } from "tamagui";
import {
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  Plus,
  ShieldCheck,
  Wallet,
} from "lucide-react-native";
import { EMPLOYEE_ACCOUNTS, SOURCE_ACCOUNT } from "@bureau/contracts";
import { useAppearance } from "./AppearanceProvider";
import {
  ActionButton,
  AllocationSummary,
  Body,
  Card,
  EmptyState,
  Eyebrow,
  Heading,
  StatusBadge,
  TextAction,
} from "./components";
import {
  accountName,
  isFinal,
  money,
  statusLabels,
  timestamp,
} from "./presentation";
import type { useBureau } from "./useBureau";

type Bureau = ReturnType<typeof useBureau>;
type Navigate = (tab: "home" | "allocate" | "activity" | "operations") => void;

export function SignIn({ bureau: b }: { bureau: Bureau }) {
  const { palette: p, mode } = useAppearance();
  const [showPassword, setShowPassword] = useState(false);
  return (
    <YStack gap={24}>
      <YStack gap={12} paddingTop={14}>
        <Eyebrow>YOUR PAYROLL, WITH A CLEARER VIEW</Eyebrow>
        <Heading large>Payroll, connected.</Heading>
        <Body fontSize={16} lineHeight={25}>
          A little clarity for every internal allocation.
        </Body>
      </YStack>
      <YStack backgroundColor="$accent" padding={24} borderRadius={26} gap={12}>
        <Wallet size={28} color={p.onAccent} aria-hidden />
        <Text color="$onAccent" fontSize={22} lineHeight={29} fontWeight="600">
          Old core. Fresh perspective.
        </Text>
        <Text color="$onAccent" fontSize={14} lineHeight={22}>
          Track payroll from the first request to its committed outcome.
        </Text>
      </YStack>
      <Card>
        <YStack gap={6}>
          <Heading>Welcome back</Heading>
          <Body>Choose a demo role and sign in.</Body>
        </YStack>
        <XStack gap={6}>
          {[
            ["Payroll", "insurer-admin"],
            ["Employee", "employee-one"],
            ["Ops", "ops"],
          ].map(([label, username]) => (
            <Button
              key={username}
              flex={1}
              minWidth={0}
              paddingHorizontal={6}
              minHeight={44}
              borderRadius={12}
              fontSize={12}
              fontWeight="600"
              disabled={b.busy}
              accessibilityLabel={`Choose ${label} demo role`}
              aria-label={`Choose ${label} demo role`}
              accessibilityState={{ selected: b.username === username }}
              aria-pressed={b.username === username}
              backgroundColor={
                b.username === username ? "$accentSoft" : "$surfaceMuted"
              }
              borderColor={
                b.username === username ? "$accentStrong" : "$borderColor"
              }
              color="$color"
              onPress={() => b.setUsername(username)}
            >
              {label}
            </Button>
          ))}
        </XStack>
        <YStack gap={8}>
          <Body color="$color" fontWeight="600">
            Username
          </Body>
          <Input
            value={b.username}
            onChangeText={b.setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            disabled={b.busy}
            accessibilityLabel="Username"
            aria-label="Username"
            autoComplete="username"
            keyboardAppearance={mode}
            minHeight={52}
            fontSize={15}
            borderRadius={14}
            backgroundColor="$surfaceMuted"
            color="$color"
            borderColor="$borderColor"
            focusStyle={{ borderColor: "$accentStrong" }}
          />
        </YStack>
        <YStack gap={8}>
          <Body color="$color" fontWeight="600">
            Password
          </Body>
          <XStack gap={8}>
            <Input
              flex={1}
              minWidth={0}
              value={b.password}
              onChangeText={b.setPassword}
              secureTextEntry={!showPassword}
              type={showPassword ? "text" : "password"}
              disabled={b.busy}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="current-password"
              keyboardAppearance={mode}
              accessibilityLabel="Password"
              aria-label="Password"
              placeholder="Demo password"
              placeholderTextColor="$muted"
              returnKeyType="go"
              onSubmitEditing={() => void b.login()}
              minHeight={52}
              fontSize={15}
              borderRadius={14}
              backgroundColor="$surfaceMuted"
              color="$color"
              borderColor="$borderColor"
              focusStyle={{ borderColor: "$accentStrong" }}
            />
            <Button
              width={48}
              height={52}
              padding={0}
              borderRadius={14}
              backgroundColor="$surfaceMuted"
              borderColor="$borderColor"
              accessibilityLabel={
                showPassword ? "Hide password" : "Show password"
              }
              aria-label={showPassword ? "Hide password" : "Show password"}
              onPress={() => setShowPassword(!showPassword)}
            >
              {showPassword ? (
                <EyeOff size={20} color={p.muted} aria-hidden />
              ) : (
                <Eye size={20} color={p.muted} aria-hidden />
              )}
            </Button>
          </XStack>
        </YStack>
        <ActionButton
          onPress={() => void b.login()}
          disabled={b.busy}
          icon={<ArrowRight size={18} />}
        >
          {b.busy ? "Signing in…" : "Sign in"}
        </ActionButton>
        <Body fontSize={12} lineHeight={19}>
          Use the demo password generated during local setup.
        </Body>
      </Card>
      <DemoNote />
    </YStack>
  );
}

export function Home({
  bureau: b,
  navigate,
}: {
  bureau: Bureau;
  navigate: Navigate;
}) {
  const { palette: p } = useAppearance();
  const employee = b.principal?.role === "employee";
  const main = b.accounts.find(
    (a) =>
      a.account === (employee ? b.principal?.employeeAccount : SOURCE_ACCOUNT),
  );
  const other = b.accounts.filter((a) => a.account !== main?.account);
  return (
    <YStack gap={22}>
      <YStack gap={8}>
        <Eyebrow>
          {employee ? "YOUR PAYROLL OVERVIEW" : "PAYROLL OVERVIEW"}
        </Eyebrow>
        <Heading large>
          {employee ? "Your pay, clearly." : "Payroll, connected."}
        </Heading>
        <Body>Your internal allocations at a glance.</Body>
      </YStack>
      <YStack
        testID="balance-hero"
        backgroundColor="$accent"
        borderRadius={26}
        padding={24}
        gap={14}
      >
        <XStack justifyContent="space-between" alignItems="center" gap={12}>
          <Text
            color="$onAccent"
            fontSize={14}
            lineHeight={21}
            fontWeight="600"
            flex={1}
          >
            {employee ? "Your payable balance" : "Employer prefunded balance"}
          </Text>
          <Wallet size={24} color={p.onAccent} aria-hidden />
        </XStack>
        <Text
          color="$onAccent"
          fontSize={34}
          lineHeight={43}
          fontWeight="700"
          letterSpacing={-1}
          adjustsFontSizeToFit
          numberOfLines={1}
          minimumFontScale={0.65}
        >
          {main ? money(main.amountMinor) : "Awaiting sync"}
        </Text>
        <Text color="$onAccent" fontSize={12} lineHeight={19}>
          {main
            ? `Core snapshot · ${timestamp(main.observedAt)}`
            : "Waiting for the first account snapshot."}
        </Text>
        {main?.state === "SUSPENDED" && (
          <Text color="$onAccent" fontWeight="700">
            Account suspended
          </Text>
        )}
      </YStack>
      <Body fontSize={12} lineHeight={19}>
        Committed core balance. Pending allocations can change it at the next
        batch.
      </Body>
      <ActionButton
        onPress={() => navigate(employee ? "activity" : "allocate")}
        icon={employee ? <ArrowRight size={18} /> : <Plus size={18} />}
      >
        {employee
          ? "View your activity"
          : b.pending
            ? "Resume unfinished request"
            : "New allocation"}
      </ActionButton>
      {b.pending && !employee && (
        <Card>
          <Heading>Unfinished request</Heading>
          <Body>
            {money(b.pending.amountMinor)} for{" "}
            {accountName(b.pending.targetAccount)} is saved on this device.
            Retry keeps its original reference.
          </Body>
        </Card>
      )}
      <YStack gap={12}>
        <XStack alignItems="center" justifyContent="space-between" gap={8}>
          <Heading>Recent activity</Heading>
          <TextAction onPress={() => navigate("activity")}>See all</TextAction>
        </XStack>
        {b.rows.slice(0, 2).map((allocation) => (
          <AllocationSummary key={allocation.id} allocation={allocation} />
        ))}
        {!b.rows.length && (
          <EmptyState title="A fresh start">
            Your allocations will appear here once a request is received.
          </EmptyState>
        )}
      </YStack>
      {!!other.length && (
        <YStack gap={12}>
          <Heading>Employee balances</Heading>
          <Card>
            {other.map((a) => (
              <YStack key={a.account} gap={4} paddingVertical={4}>
                <XStack
                  alignItems="center"
                  justifyContent="space-between"
                  flexWrap="wrap"
                  gap={8}
                >
                  <Text color="$color" fontWeight="600" fontSize={14}>
                    {accountName(a.account)}
                  </Text>
                  <Text color="$color" fontWeight="600" fontSize={16}>
                    {money(a.amountMinor)}
                  </Text>
                </XStack>
                <Body
                  fontSize={12}
                  lineHeight={19}
                  color={a.state === "SUSPENDED" ? "$danger" : "$muted"}
                >
                  {a.state === "SUSPENDED" ? "Suspended" : "Active"} ·{" "}
                  {timestamp(a.observedAt)}
                </Body>
              </YStack>
            ))}
          </Card>
        </YStack>
      )}
      <DemoNote />
    </YStack>
  );
}

export function Allocate({
  bureau: b,
  navigate,
}: {
  bureau: Bureau;
  navigate: Navigate;
}) {
  const { palette: p, mode } = useAppearance();
  const locked = b.busy || !!b.pending;
  return (
    <YStack gap={22}>
      <YStack gap={8}>
        <Eyebrow>INSURER PAYROLL</Eyebrow>
        <Heading large>New allocation</Heading>
        <Body>Assign prefunded value to an employee's payable balance.</Body>
      </YStack>
      <Card>
        <Heading>Choose an employee</Heading>
        {EMPLOYEE_ACCOUNTS.map((id, index) => (
          <Button
            key={id}
            unstyled
            disabled={locked}
            onPress={() => b.setEmployee(id)}
            accessibilityRole="radio"
            role="radio"
            accessibilityLabel={`Employee ${index + 1}${index === 2 ? ", suspended" : ""}`}
            aria-label={`Employee ${index + 1}${index === 2 ? ", suspended" : ""}`}
            accessibilityState={{
              checked: b.employee === id,
              disabled: locked,
            }}
            aria-disabled={locked}
            aria-checked={b.employee === id}
            minHeight={78}
            height="auto"
            padding={14}
            borderRadius={16}
            borderWidth={1}
            borderColor={b.employee === id ? "$accentStrong" : "$borderColor"}
            backgroundColor={b.employee === id ? "$accentSoft" : "$surface"}
            opacity={b.busy ? 0.5 : 1}
            pressStyle={{ opacity: 0.8 }}
            focusStyle={{ outlineColor: "$accentStrong", outlineWidth: 2 }}
          >
            <XStack gap={12} alignItems="center" width="100%">
              <YStack
                width={40}
                height={40}
                borderRadius={13}
                backgroundColor="$surfaceMuted"
                alignItems="center"
                justifyContent="center"
              >
                <Text color="$color" fontWeight="600" fontSize={14}>
                  E{index + 1}
                </Text>
              </YStack>
              <YStack flex={1} gap={3}>
                <Text color="$color" fontSize={15} fontWeight="600">
                  Employee {index + 1}
                </Text>
                <Body
                  fontSize={12}
                  lineHeight={18}
                  color={index === 2 ? "$danger" : "$muted"}
                >
                  {index === 2
                    ? "Suspended · demo decline"
                    : "Active payable account"}
                </Body>
              </YStack>
              {b.employee === id && (
                <Check size={20} color={p.accentStrong} aria-hidden />
              )}
            </XStack>
          </Button>
        ))}
      </Card>
      <Card>
        <XStack alignItems="center" justifyContent="space-between">
          <Heading>Amount</Heading>
          <Eyebrow>ZAR</Eyebrow>
        </XStack>
        <Input
          keyboardType="decimal-pad"
          inputMode="decimal"
          keyboardAppearance={mode}
          value={b.amount}
          disabled={locked}
          onChangeText={b.setAmount}
          accessibilityLabel="Amount in rand"
          aria-label="Amount in rand"
          minHeight={72}
          fontSize={30}
          fontWeight="600"
          backgroundColor="$surfaceMuted"
          color="$color"
          borderColor="$borderColor"
          borderRadius={16}
          focusStyle={{ borderColor: "$accentStrong" }}
        />
        <Body fontSize={12} lineHeight={19}>
          From the insurer's prefunded account. Demo core limit: R50,000 per
          allocation.
        </Body>
        {b.pending && (
          <YStack
            backgroundColor="$warningSurface"
            borderRadius={14}
            padding={14}
            gap={8}
          >
            <Text color="$warning" fontSize={14} fontWeight="600">
              Retry the saved request
            </Text>
            <Body color="$warning">
              Amount and employee stay fixed until this request is acknowledged.
            </Body>
            <Body color="$warning" fontSize={12} selectable>
              {b.pending.key}
            </Body>
          </YStack>
        )}
        <ActionButton
          disabled={b.busy}
          onPress={() => {
            void b.allocate().then((received) => {
              if (received) navigate("activity");
            });
          }}
          icon={<ArrowRight size={18} />}
        >
          {b.busy
            ? "Sending request…"
            : b.pending
              ? "Retry same request"
              : "Submit allocation"}
        </ActionButton>
        <Body fontSize={12} lineHeight={19}>
          This posts internally after batch processing. External bank payout is
          a separate step.
        </Body>
      </Card>
    </YStack>
  );
}

export function Activity({ bureau: b }: { bureau: Bureau }) {
  const [filter, setFilter] = useState<"all" | "pending" | "complete">("all");
  const rows = b.rows.filter(
    (a) =>
      filter === "all" ||
      (filter === "complete" ? isFinal(a.status) : !isFinal(a.status)),
  );
  const ops = b.principal?.role === "ops";
  return (
    <YStack gap={20}>
      <YStack gap={8}>
        <Eyebrow>ALLOCATION REGISTER</Eyebrow>
        <Heading large>Your activity</Heading>
        <Body>Follow each request through the batch and into the core.</Body>
      </YStack>
      <XStack alignItems="center" justifyContent="space-between" gap={8}>
        <Body fontSize={12}>Latest {b.rows.length} allocations</Body>
        <TextAction onPress={() => void b.refresh()}>Refresh</TextAction>
      </XStack>
      <XStack gap={6}>
        {(
          [
            ["all", "All"],
            ["pending", "In progress"],
            ["complete", "Completed"],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            flex={1}
            minWidth={0}
            minHeight={44}
            paddingHorizontal={5}
            borderRadius={12}
            fontSize={12}
            fontWeight="600"
            accessibilityState={{ selected: filter === value }}
            aria-pressed={filter === value}
            backgroundColor={filter === value ? "$accentSoft" : "$surface"}
            borderColor={filter === value ? "$accentStrong" : "$borderColor"}
            color="$color"
            onPress={() => setFilter(value)}
          >
            {label}
          </Button>
        ))}
      </XStack>
      {!rows.length && (
        <EmptyState
          title={b.rows.length ? "Nothing in this view" : "No allocations yet"}
        >
          {b.rows.length
            ? "Choose another filter to explore the register."
            : "Received requests and their outcomes will appear here."}
        </EmptyState>
      )}
      {rows.map((a) => (
        <Card key={a.id}>
          <XStack
            justifyContent="space-between"
            alignItems="center"
            gap={12}
            flexWrap="wrap"
          >
            <Heading>{accountName(a.targetAccount)}</Heading>
            <Text color="$color" fontSize={22} lineHeight={29} fontWeight="600">
              {money(a.amountMinor)}
            </Text>
          </XStack>
          <StatusBadge status={a.status} />
          <YStack gap={5}>
            <Body fontSize={12}>Updated {timestamp(a.updatedAt)}</Body>
            <Body fontSize={12} lineHeight={19} selectable>
              Account · {a.targetAccount}
            </Body>
            <Body fontSize={12} lineHeight={19} selectable>
              Reference · {a.id}
            </Body>
            {!!a.postingId && (
              <Body fontSize={12} lineHeight={19} selectable>
                Posting · {a.postingId}
              </Body>
            )}
            {!!a.reason && a.reason !== "OK" && (
              <Body color="$danger">{a.reason.replaceAll("_", " ")}</Body>
            )}
          </YStack>
          <ActionButton
            secondary
            disabled={b.busy}
            onPress={() => void b.viewHistory(a.id)}
          >
            {b.history?.id === a.id ? "Hide history" : "View status history"}
          </ActionButton>
          {b.history?.id === a.id && (
            <YStack gap={16} paddingTop={4}>
              {b.history.events.map((event, index) => (
                <YStack
                  key={index}
                  borderLeftWidth={2}
                  borderLeftColor="$accent"
                  paddingLeft={14}
                  gap={3}
                >
                  <Text
                    color="$color"
                    fontSize={13}
                    lineHeight={20}
                    fontWeight="600"
                  >
                    {statusLabels[event.status as keyof typeof statusLabels] ??
                      event.status}
                  </Text>
                  <Body fontSize={12} lineHeight={19}>
                    {timestamp(event.createdAt)}
                  </Body>
                  {!!event.reason && (
                    <Body fontSize={12}>
                      {event.reason.replaceAll("_", " ")}
                    </Body>
                  )}
                </YStack>
              ))}
              {!b.history.events.length && (
                <Body>No saved status events yet.</Body>
              )}
            </YStack>
          )}
          {ops && (
            <YStack gap={10}>
              <ActionButton
                secondary
                disabled={b.busy}
                onPress={() => void b.inquire(a.id)}
              >
                Run core inquiry
              </ActionButton>
              {["NEEDS_REVIEW", "VERIFYING", "PROCESSING"].includes(
                a.status,
              ) && (
                <ActionButton
                  secondary
                  disabled={b.busy}
                  onPress={() => void b.resume(a.id)}
                >
                  Verify and resume
                </ActionButton>
              )}
            </YStack>
          )}
        </Card>
      ))}
      <DemoNote />
    </YStack>
  );
}

export function Operations({ bureau: b }: { bureau: Bureau }) {
  const report = b.report;
  return (
    <YStack gap={22}>
      <YStack gap={8}>
        <Eyebrow>OPERATIONS</Eyebrow>
        <Heading large>Reconciliation</Heading>
        <Body>
          Compare the modern register, legacy intake, and core journal.
        </Body>
      </YStack>
      <Card>
        <Heading>A shared view of the outcome</Heading>
        <Body>
          A finding may reflect an import in progress. Investigate the reference
          in Activity before recovery.
        </Body>
        <ActionButton disabled={b.busy} onPress={() => void b.reconcile()}>
          {b.busy ? "Working…" : "Run comparison"}
        </ActionButton>
        <ActionButton
          secondary
          disabled={b.busy || !report}
          onPress={() => void b.exportReport()}
        >
          Export CSV
        </ActionButton>
      </Card>
      {report ? (
        <Card>
          <Heading>Latest observation</Heading>
          <Body>Checked {timestamp(report.createdAt)}</Body>
          <XStack gap={8}>
            {[
              ["Modern", report.modernCount],
              ["Intake", report.intakeCount],
              ["Core", report.coreCount],
            ].map(([label, count]) => (
              <YStack
                key={label}
                flex={1}
                backgroundColor="$surfaceMuted"
                borderRadius={14}
                padding={12}
                gap={6}
              >
                <Body fontSize={12}>{label}</Body>
                <Text color="$color" fontSize={22} fontWeight="600">
                  {count}
                </Text>
              </YStack>
            ))}
          </XStack>
          {report.truncated && (
            <Body color="$warning">
              Incomplete scan: the demo record limit was reached.
            </Body>
          )}
          {!report.findings.length && (
            <Body color={report.truncated ? "$warning" : "$success"}>
              {report.truncated
                ? "No findings in the scanned records. This is not a complete comparison."
                : "No discrepancies in this observation."}
            </Body>
          )}
          {report.findings.slice(0, 20).map((f, index) => (
            <YStack
              key={index}
              borderTopWidth={1}
              borderTopColor="$borderColor"
              paddingTop={16}
              gap={6}
            >
              <Text
                color={
                  f.severity === "HIGH"
                    ? "$danger"
                    : f.severity === "WARN"
                      ? "$warning"
                      : "$accentStrong"
                }
                fontSize={13}
                lineHeight={20}
                fontWeight="600"
              >
                {f.severity} · {f.code.replaceAll("_", " ")}
              </Text>
              {!!f.reference && (
                <Body fontSize={12} lineHeight={19} selectable>
                  {f.reference}
                </Body>
              )}
              <Body>{f.details}</Body>
            </YStack>
          ))}
          {report.findings.length > 20 && (
            <Body>
              Showing 20 findings. Export the CSV for the full report.
            </Body>
          )}
        </Card>
      ) : (
        <EmptyState title="No comparison yet">
          Run a comparison to save the first observation.
        </EmptyState>
      )}
      <DemoNote />
    </YStack>
  );
}

function DemoNote() {
  const { palette: p } = useAppearance();
  return (
    <XStack
      gap={8}
      justifyContent="center"
      alignItems="center"
      paddingVertical={10}
    >
      <ShieldCheck size={15} color={p.muted} aria-hidden />
      <Body fontSize={12} lineHeight={19}>
        Fictional payroll demo · ZAR
      </Body>
    </XStack>
  );
}
