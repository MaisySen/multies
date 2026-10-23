/** Shared shapes for DNS setup and verification, used by API and UI. */
export type DnsRecordId = "ownership" | "mx" | "spf" | "dkim" | "dmarc";
export type DnsCheckStatus = "pass" | "warn" | "fail" | "error" | "pending";

export interface ExpectedRecord {
  id: DnsRecordId;
  type: "TXT" | "MX";
  /** Host label relative to the domain: `@` for the apex. */
  host: string;
  /** Fully qualified name that gets queried. */
  fqdn: string;
  /** Value to publish. For MX this is one entry per host (see `values`). */
  value: string;
  values?: { value: string; priority: number }[];
  required: boolean;
  title: string;
  why: string;
}

export interface RecordCheck {
  id: DnsRecordId;
  status: DnsCheckStatus;
  found: string[];
  message: string;
  /** For SPF: a merged record that keeps what they already publish. */
  suggestion?: string;
}

export interface DnsCheckReport {
  checkedAt: string;
  verified: boolean;
  records: RecordCheck[];
}
