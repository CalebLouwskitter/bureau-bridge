import {
  EMPLOYEE_ACCOUNTS,
  SOURCE_ACCOUNT,
  type Status,
} from "@bureau/contracts";

export const statusLabels: Record<Status, string> = {
  QUEUED: "Request received",
  AWAITING_BATCH: "Awaiting payroll batch",
  PROCESSING: "Batch in progress",
  VERIFYING: "Verifying core outcome",
  POSTED: "Posted internally",
  DECLINED: "Allocation declined",
  NEEDS_REVIEW: "Operations review needed",
};

export function accountName(account: string) {
  if (account === SOURCE_ACCOUNT) return "Employer prefund";
  const index = EMPLOYEE_ACCOUNTS.findIndex((id) => id === account);
  return index < 0 ? account : `Employee ${index + 1}`;
}

export const money = (minor: number) =>
  `R${(minor / 100).toLocaleString("en-ZA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

// The bureau's cutoffs and displayed observations use the same timezone.
export const timestamp = (value: string) =>
  new Date(value).toLocaleString("en-ZA", {
    timeZone: "Africa/Johannesburg",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }) + " SAST";

export const isFinal = (status: Status) =>
  status === "POSTED" || status === "DECLINED";
