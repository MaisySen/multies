/**
 * TD9 (flag PORTAL_TD9): client portal access per area, the live project view and private comments.
 * Shared by the server and the team pages.
 */
export const PORTAL_AREAS = ["projects", "tasks", "files", "docs", "invoices", "forms"] as const;
export type PortalArea = (typeof PORTAL_AREAS)[number];
export const PORTAL_LEVELS = ["none", "view", "comment"] as const;
export type PortalLevel = (typeof PORTAL_LEVELS)[number];

/** With no row: what clients already saw before TD9 stays visible; areas new in TD9 start hidden. */
export const DEFAULT_LEVELS: Record<PortalArea, PortalLevel> = { projects: "none", tasks: "view", files: "view", docs: "view", invoices: "none", forms: "none" };

export const AREA_LABEL: Record<PortalArea, string> = { projects: "Projects", tasks: "Tasks", files: "Files", docs: "Docs", invoices: "Invoices", forms: "Forms" };
export const LEVEL_LABEL: Record<PortalLevel, string> = { none: "None", view: "View", comment: "Comment" };

export type Td9Kind = "file" | "doc" | "task" | "request" | "project" | "invoice" | "form";
/** The area a shared item belongs to. File requests go with files. */
export function areaOf(kind: Td9Kind): PortalArea {
  if (kind === "file" || kind === "request") return "files";
  if (kind === "doc") return "docs";
  if (kind === "task") return "tasks";
  if (kind === "project") return "projects";
  if (kind === "invoice") return "invoices";
  return "forms";
}
export const canView = (l: PortalLevel | undefined) => l === "view" || l === "comment";
export const canComment = (l: PortalLevel | undefined) => l === "comment";
export const isLevel = (v: unknown): v is PortalLevel => typeof v === "string" && (PORTAL_LEVELS as readonly string[]).includes(v);
export const isArea = (v: unknown): v is PortalArea => typeof v === "string" && (PORTAL_AREAS as readonly string[]).includes(v);

export const COMMENT_TD9_MAX = 4000;
export const MILESTONE_MAX = 50;

export interface Td9Comment {
  id: string; body: string; at: string;
  author: { name: string; client: boolean; me: boolean };
  /** Set when the comment is private: who it is between, worded for the reader ("Only you and Sam"). */
  privateLabel: string | null;
  canDelete: boolean;
}
export interface Td9Recipient { kind: "member" | "client"; id: string; name: string; sub: string }
export interface Td9Milestone { id: string; title: string; due: string | null; done: boolean }
export interface Td9AccessHistory { at: string; by: string; area: PortalArea; from: PortalLevel; to: PortalLevel }

/** The privacy line under a private comment, from the reader's side. */
export function privateLabel(o: { meIsAuthor: boolean; meIsTarget: boolean; authorName: string; targetName: string }): string {
  if (o.meIsAuthor) return `Only you and ${o.targetName}`;
  if (o.meIsTarget) return `Only you and ${o.authorName}`;
  return `Private: ${o.authorName} to ${o.targetName}`;
}
