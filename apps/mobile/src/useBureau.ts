import { useEffect, useRef, useState } from "react";
import { Platform, Share } from "react-native";
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
export function useBureau() {
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
      setMessage("Request received. Follow the batch status in Activity.");
      await refresh();
      return true;
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
  function signOut() {
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
  }
  return {
    username,
    setUsername,
    password,
    setPassword,
    token,
    principal,
    rows,
    accounts,
    report,
    history,
    amount,
    setAmount,
    employee,
    setEmployee,
    message,
    busy,
    pending: pending.current,
    clearMessage: () => setMessage(""),
    login,
    signOut,
    allocate,
    refresh,
    inquire,
    resume,
    reconcile,
    exportReport,
    viewHistory,
  };
}
