import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { randomUUID } from "expo-crypto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  SOURCE_ACCOUNT,
  EMPLOYEE_ACCOUNTS,
  parsePending,
  type Allocation,
  type Principal,
  type PendingRequest,
  type AccountProjection,
  type ReconciliationRun,
} from "@bureau/contracts";
const API =
  process.env.EXPO_PUBLIC_API_URL ??
  (Platform.OS === "android"
    ? "http://10.0.2.2:3000"
    : "http://localhost:3000");
const labels: Record<string, string> = {
  QUEUED: "Request received",
  AWAITING_BATCH: "Awaiting payroll batch",
  PROCESSING: "Batch in progress",
  VERIFYING: "Verifying core outcome",
  POSTED: "Posted internally",
  DECLINED: "Allocation declined",
  NEEDS_REVIEW: "Operations review needed",
};
export default function App() {
  const [username, setUsername] = useState("insurer-admin"),
    [password, setPassword] = useState(""),
    [token, setToken] = useState("");
  const [principal, setPrincipal] = useState<Principal | null>(null),
    [rows, setRows] = useState<Allocation[]>([]);
  const [accounts, setAccounts] = useState<AccountProjection[]>([]),
    [report, setReport] = useState<ReconciliationRun | null>(null),
    [history, setHistory] = useState<{
      id: string;
      events: { status: string; reason: string | null; createdAt: string }[];
    } | null>(null);
  const [amount, setAmount] = useState("250.00"),
    [employee, setEmployee] = useState<string>(EMPLOYEE_ACCOUNTS[0]);
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const pending = useRef<PendingRequest | null>(null),
    actionBusy = useRef(false),
    sessionGeneration = useRef(0),
    refreshBusy = useRef<number | null>(null);
  function beginAction() {
    if (actionBusy.current) return false;
    actionBusy.current = true;
    setBusy(true);
    return true;
  }
  function endAction() {
    actionBusy.current = false;
    setBusy(false);
  }
  async function call(path: string, init: RequestInit = {}, text = false) {
    const result = await fetch(API + path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!result.ok) {
      const data = await result.json().catch(() => ({}));
      throw new Error(data.error ?? "Request failed");
    }
    return text ? result.text() : result.json();
  }
  async function refresh() {
    const generation = sessionGeneration.current;
    if (!token || refreshBusy.current === generation) return;
    refreshBusy.current = generation;
    try {
      const [allocations, balances, reconciliation] = await Promise.all([
        call("/allocations"),
        call("/accounts"),
        principal?.role === "ops"
          ? call("/reconciliation")
          : Promise.resolve(null),
      ]);
      if (generation !== sessionGeneration.current) return;
      setRows(allocations.allocations);
      setAccounts(balances.accounts);
      setReport(reconciliation?.run ?? null);
    } catch (error) {
      if (generation === sessionGeneration.current)
        setMessage((error as Error).message);
    } finally {
      if (refreshBusy.current === generation) refreshBusy.current = null;
    }
  }
  useEffect(() => {
    if (!token) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [token]);
  async function login() {
    if (!beginAction()) return;
    setMessage("");
    try {
      const data = await call("/session", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      const saved = await AsyncStorage.getItem(
        "bureau-pending:" + data.principal.username,
      );
      pending.current = null;
      const value = parsePending(saved);
      if (value) {
        pending.current = value;
        setAmount((value.amountMinor / 100).toFixed(2));
        setEmployee(value.targetAccount);
        setMessage(
          "An unfinished request was restored. Retry uses its original reference.",
        );
      } else if (saved) {
        await AsyncStorage.removeItem(
          "bureau-pending:" + data.principal.username,
        );
        setMessage(
          "A damaged saved request was removed. Check the allocation register before submitting again.",
        );
      }
      sessionGeneration.current += 1;
      setToken(data.token);
      setPrincipal(data.principal);
      setPassword("");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      endAction();
    }
  }
  async function allocate() {
    if (actionBusy.current) return;
    if (!/^\d{1,10}(\.\d{1,2})?$/.test(amount)) {
      setMessage("Enter a rand amount with at most two decimal places.");
      return;
    }
    const [whole, fraction = ""] = amount.split(".");
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    if (!Number.isSafeInteger(cents) || cents < 1 || cents > 999999999999) {
      setMessage("Amount is outside the supported range.");
      return;
    }
    if (!beginAction()) return;
    if (!pending.current)
      pending.current = {
        key: randomUUID(),
        amountMinor: cents,
        targetAccount: employee,
      };
    setMessage("");
    try {
      const request = pending.current;
      // Persist the immutable request before sending, so app restart preserves replay safety.
      await AsyncStorage.setItem(
        "bureau-pending:" + principal!.username,
        JSON.stringify(request),
      );
      await call("/allocations", {
        method: "POST",
        headers: { "Idempotency-Key": request.key },
        body: JSON.stringify({
          sourceAccount: SOURCE_ACCOUNT,
          targetAccount: request.targetAccount,
          amountMinor: request.amountMinor,
          currency: "ZAR",
        }),
      });
      await AsyncStorage.removeItem("bureau-pending:" + principal!.username);
      pending.current = null;
      setMessage("Received. Follow the batch status below.");
      await refresh();
    } catch (error) {
      setMessage(
        (error as Error).message + " · Retry sends the same request reference.",
      );
    } finally {
      endAction();
    }
  }
  async function inquire(id: string) {
    if (!beginAction()) return;
    try {
      await call(`/allocations/${id}/inquiry`, { method: "POST", body: "{}" });
      setMessage("Core inquiry complete. Refreshing the recorded outcome.");
      await refresh();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      endAction();
    }
  }
  async function resume(id: string) {
    if (!beginAction()) return;
    try {
      await call(`/allocations/${id}/resume`, { method: "POST", body: "{}" });
      setMessage("Recovery requested using the original reference.");
      await refresh();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      endAction();
    }
  }
  async function reconcile() {
    if (!beginAction()) return;
    try {
      setReport(
        (await call("/reconciliation", { method: "POST", body: "{}" })).run,
      );
      setMessage("Reconciliation observation saved.");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      endAction();
    }
  }
  async function exportReport() {
    if (!beginAction()) return;
    try {
      const csv = await call("/reconciliation/report.csv", {}, true);
      if (Platform.OS === "web") {
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = "reconciliation.csv";
        link.click();
        URL.revokeObjectURL(url);
      } else await Share.share({ title: "Reconciliation CSV", message: csv });
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      endAction();
    }
  }
  async function viewHistory(id: string) {
    if (history?.id === id) {
      setHistory(null);
      return;
    }
    if (!beginAction()) return;
    try {
      const data = await call("/allocations/" + id);
      setHistory({ id, events: data.events });
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      endAction();
    }
  }
  return (
    <SafeAreaView style={s.safe}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={s.page}>
        <Text style={s.eyebrow}>BUREAU / BRIDGE</Text>
        <Text style={s.title}>Payroll, connected.</Text>
        <Text style={s.subtitle}>
          A clearer view of every internal allocation.
        </Text>
        <View style={s.banner}>
          <View style={s.dot} />
          <Text style={s.bannerText}>FICTIONAL PAYROLL DEMO · ZAR</Text>
        </View>
        {!token ? (
          <View style={s.card}>
            <Text style={s.heading}>Welcome back</Text>
            <Text style={s.copy}>
              Use insurer-admin, employee-one, or ops with the demo password
              generated during setup.
            </Text>
            <TextInput
              style={s.input}
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              accessibilityLabel="Username"
            />
            <TextInput
              style={s.input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholder="Demo password"
              placeholderTextColor="#718b98"
              accessibilityLabel="Password"
            />
            <Pressable style={s.button} onPress={login} disabled={busy}>
              <Text style={s.buttonText}>Sign in</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={s.row}>
              <Text style={s.copy}>{principal?.username}</Text>
              <Pressable
                disabled={busy}
                onPress={() => {
                  if (actionBusy.current) return;
                  sessionGeneration.current += 1;
                  setToken("");
                  setPrincipal(null);
                  setRows([]);
                  setAccounts([]);
                  setReport(null);
                  setHistory(null);
                  setMessage("");
                  pending.current = null;
                }}
              >
                <Text style={s.link}>Sign out</Text>
              </Pressable>
            </View>
            <View style={s.card}>
              <Text style={s.heading}>Account balances</Text>
              <Text style={s.copy}>
                Balances reflect the last committed core snapshot. Pending
                allocations can change them at the next batch.
              </Text>
              {!accounts.length && (
                <Text style={s.copy}>Waiting for the first account sync.</Text>
              )}
              {accounts.map((a) => (
                <View key={a.account} style={s.transaction}>
                  <Text style={s.copy}>
                    {a.account} · {a.state.toLowerCase()}
                  </Text>
                  <Text style={s.money}>
                    R{" "}
                    {(a.amountMinor / 100).toLocaleString("en-ZA", {
                      minimumFractionDigits: 2,
                    })}
                  </Text>
                  <Text style={s.reference}>
                    Core snapshot: {new Date(a.observedAt).toLocaleString()}
                  </Text>
                </View>
              ))}
            </View>
            {principal?.role !== "employee" && (
              <View style={s.card}>
                <Text style={s.kicker}>INSURER DEMO / PAYROLL</Text>
                <Text style={s.heading}>New allocation</Text>
                <Text style={s.copy}>
                  Assign value to an employee payable balance. External bank
                  payout is a separate step.
                </Text>
                <Text style={s.label}>EMPLOYEE ACCOUNT</Text>
                <View style={s.row}>
                  {EMPLOYEE_ACCOUNTS.map((id, i) => (
                    <Pressable
                      key={id}
                      disabled={busy || !!pending.current}
                      style={[s.choice, employee === id && s.selected]}
                      onPress={() => setEmployee(id)}
                    >
                      <Text style={s.choiceText}>
                        Employee {i + 1}
                        {i === 2 ? " · suspended" : ""}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={s.label}>AMOUNT · RAND</Text>
                <TextInput
                  style={[s.input, s.amount]}
                  keyboardType="decimal-pad"
                  value={amount}
                  editable={!busy && !pending.current}
                  onChangeText={setAmount}
                  accessibilityLabel="Amount in rand"
                />
                <Pressable style={s.button} disabled={busy} onPress={allocate}>
                  <Text style={s.buttonText}>
                    {pending.current
                      ? "Retry same request"
                      : "Submit allocation"}
                  </Text>
                </Pressable>
              </View>
            )}
            {principal?.role === "ops" && (
              <View style={s.card}>
                <Text style={s.heading}>Reconciliation</Text>
                <Text style={s.copy}>
                  Compare the modern register, legacy intake, and core journal.
                  A finding may reflect an import in progress; investigate
                  before recovery.
                </Text>
                <View style={s.row}>
                  <Pressable disabled={busy} onPress={reconcile}>
                    <Text style={s.link}>Run comparison</Text>
                  </Pressable>
                  <Pressable disabled={busy || !report} onPress={exportReport}>
                    <Text style={s.link}>Export CSV</Text>
                  </Pressable>
                </View>
                {report ? (
                  <>
                    <Text style={s.copy}>
                      {report.modernCount} modern · {report.intakeCount} intake
                      · {report.coreCount} core
                    </Text>
                    <Text style={s.reference}>
                      Checked {new Date(report.createdAt).toLocaleString()}
                    </Text>
                    {report.truncated && (
                      <Text style={s.message}>
                        Incomplete scan: the demo record limit was reached.
                      </Text>
                    )}
                    {!report.findings.length && (
                      <Text style={s.copy}>
                        No discrepancies in this observation.
                      </Text>
                    )}
                    {report.findings.slice(0, 20).map((f, i) => (
                      <View key={i} style={s.transaction}>
                        <Text style={s.status}>
                          {f.severity} · {f.code}
                        </Text>
                        {!!f.reference && (
                          <Text style={s.reference}>{f.reference}</Text>
                        )}
                        <Text style={s.copy}>{f.details}</Text>
                      </View>
                    ))}
                    {report.findings.length > 20 && (
                      <Text style={s.copy}>
                        Showing 20 findings; the CSV contains the full report.
                      </Text>
                    )}
                  </>
                ) : (
                  <Text style={s.copy}>No saved comparison yet.</Text>
                )}
              </View>
            )}
            <View style={s.row}>
              <Text style={s.heading}>Allocation register</Text>
              <Pressable onPress={refresh}>
                <Text style={s.link}>Refresh</Text>
              </Pressable>
            </View>
            {rows.length === 0 && (
              <Text style={s.copy}>Your allocations will appear here.</Text>
            )}
            {rows.map((a) => (
              <View style={s.transaction} key={a.id}>
                <View style={s.row}>
                  <Text style={s.money}>
                    R{" "}
                    {(a.amountMinor / 100).toLocaleString("en-ZA", {
                      minimumFractionDigits: 2,
                    })}
                  </Text>
                  <Text style={[s.status, a.status === "POSTED" && s.posted]}>
                    {labels[a.status] ?? a.status}
                  </Text>
                </View>
                <Text style={s.copy}>{a.targetAccount}</Text>
                <Text style={s.reference}>{a.id}</Text>
                <Text style={s.reference}>
                  Updated {new Date(a.updatedAt).toLocaleString()}
                </Text>
                {!!a.postingId && (
                  <Text style={s.reference}>Posting: {a.postingId}</Text>
                )}
                <Pressable disabled={busy} onPress={() => viewHistory(a.id)}>
                  <Text style={s.link}>
                    {history?.id === a.id
                      ? "Hide history"
                      : "View status history"}
                  </Text>
                </Pressable>
                {history?.id === a.id &&
                  history.events.map((event, i) => (
                    <Text key={i} style={s.copy}>
                      {new Date(event.createdAt).toLocaleString()} ·{" "}
                      {labels[event.status] ?? event.status}
                      {event.reason ? " · " + event.reason : ""}
                    </Text>
                  ))}
                {a.reason && a.reason !== "OK" && (
                  <Text style={s.copy}>{a.reason}</Text>
                )}
                {principal?.role === "ops" && (
                  <View style={s.row}>
                    <Pressable disabled={busy} onPress={() => inquire(a.id)}>
                      <Text style={s.link}>Run core inquiry</Text>
                    </Pressable>
                    {["NEEDS_REVIEW", "VERIFYING", "PROCESSING"].includes(
                      a.status,
                    ) && (
                      <Pressable disabled={busy} onPress={() => resume(a.id)}>
                        <Text style={s.link}>Verify and resume</Text>
                      </Pressable>
                    )}
                  </View>
                )}
              </View>
            ))}
          </>
        )}
        {busy && <ActivityIndicator color="#79e1b6" />}
        {!!message && (
          <Text accessibilityLiveRegion="polite" style={s.message}>
            {message}
          </Text>
        )}
        <Text style={s.footer}>
          Modern visibility. Legacy ledger authority.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#0c1a24" },
  page: {
    padding: 24,
    paddingTop: 48,
    maxWidth: 740,
    width: "100%",
    alignSelf: "center",
    gap: 18,
  },
  eyebrow: {
    color: "#79e1b6",
    fontSize: 12,
    letterSpacing: 4,
    fontWeight: "700",
  },
  title: {
    color: "#f2f6f7",
    fontSize: 38,
    fontWeight: "700",
    letterSpacing: -1.5,
  },
  subtitle: { color: "#95aebb", fontSize: 17 },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingVertical: 14,
    borderBottomColor: "#29404b",
    borderBottomWidth: 1,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#79e1b6" },
  bannerText: { color: "#adc2cc", fontSize: 10, letterSpacing: 1.5 },
  card: {
    backgroundColor: "#142833",
    borderColor: "#29404b",
    borderWidth: 1,
    borderRadius: 18,
    padding: 22,
    gap: 16,
  },
  heading: { color: "#eff6f7", fontSize: 22, fontWeight: "600" },
  copy: { color: "#a3bac5", fontSize: 14, lineHeight: 22 },
  input: {
    backgroundColor: "#0b1c27",
    color: "#f2f6f7",
    padding: 14,
    borderRadius: 9,
    borderColor: "#33505b",
    borderWidth: 1,
    fontSize: 16,
  },
  amount: { fontSize: 32, fontWeight: "600" },
  button: {
    backgroundColor: "#79e1b6",
    padding: 16,
    alignItems: "center",
    borderRadius: 10,
  },
  buttonText: { color: "#0c2b23", fontWeight: "700", fontSize: 15 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
  },
  link: {
    color: "#79e1b6",
    fontSize: 13,
    fontWeight: "600",
    paddingVertical: 5,
  },
  kicker: { color: "#79e1b6", fontSize: 10, letterSpacing: 2 },
  label: { color: "#8eabb8", fontSize: 10, letterSpacing: 1.8 },
  choice: {
    flex: 1,
    borderColor: "#34515d",
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
  },
  selected: { backgroundColor: "#214e46", borderColor: "#79e1b6" },
  choiceText: { color: "#e3efed", textAlign: "center", fontSize: 12 },
  transaction: {
    padding: 19,
    backgroundColor: "#12252f",
    borderRadius: 12,
    gap: 9,
  },
  money: { color: "#eff6f7", fontSize: 22, fontWeight: "600" },
  status: { color: "#e4c47e", fontSize: 11, maxWidth: 180 },
  posted: { color: "#79e1b6" },
  reference: { color: "#698996", fontSize: 10 },
  message: { color: "#e6cc8e", lineHeight: 22 },
  footer: {
    color: "#60808e",
    fontSize: 11,
    textAlign: "center",
    marginTop: 16,
  },
});
