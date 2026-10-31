/**
 * R89: starter whiteboards and diagrams for the templates picker. Elements carry only the fields that matter; the
 * board fills in the rest (stroke style, roughness, seeds) when it opens them.
 */
import { whiteboardDocContent } from "./docs-visual";

type El = Record<string, unknown>;
let seq = 0;
const base = (type: string, x: number, y: number, w: number, h: number, extra: El = {}): El => {
  seq += 1;
  return { id: `tpl${seq}`, type, x, y, width: w, height: h, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, roundness: { type: 3 }, seed: 1000 + seq, version: 1, versionNonce: 5000 + seq, isDeleted: false, groupIds: [], frameId: null, boundElements: null, link: null, locked: false, index: `a${String(seq).padStart(3, "0")}`, ...extra };
};
const rect = (x: number, y: number, w: number, h: number, bg: string, extra: El = {}) => base("rectangle", x, y, w, h, { backgroundColor: bg, ...extra });
const text = (x: number, y: number, t: string, size = 20, extra: El = {}) =>
  base("text", x, y, Math.max(40, t.length * size * 0.55), size * 1.25 * t.split("\n").length, { text: t, originalText: t, fontSize: size, fontFamily: 5, textAlign: "left", verticalAlign: "top", containerId: null, autoResize: true, lineHeight: 1.25, roundness: null, ...extra });
const arrow = (x: number, y: number, dx: number, dy: number) => base("arrow", x, y, Math.abs(dx), Math.abs(dy), { points: [[0, 0], [dx, dy]], roundness: { type: 2 }, startArrowhead: null, endArrowhead: "arrow", startBinding: null, endBinding: null, lastCommittedPoint: null });

function retro(): El[] {
  seq = 0;
  const cols: [string, string, string[]][] = [
    ["Went well", "#d3f9d8", ["Shipped on time", "Clear brief"]],
    ["To improve", "#fff3bf", ["Too many meetings", "Late feedback"]],
    ["Actions", "#d0ebff", ["One review a week", "Share drafts early"]],
  ];
  const out: El[] = [text(0, -70, "Sprint retro", 32)];
  cols.forEach(([title, bg, notes], i) => {
    const x = i * 340;
    out.push(rect(x, 0, 300, 460, "transparent", { strokeColor: "#868e96", strokeStyle: "dashed", strokeWidth: 1 }));
    out.push(text(x + 20, 18, title, 24));
    notes.forEach((n, j) => {
      out.push(rect(x + 20, 80 + j * 130, 260, 110, bg, { strokeColor: "#868e96", strokeWidth: 1, roughness: 0 }));
      out.push(text(x + 36, 96 + j * 130, n, 18));
    });
  });
  return out;
}

function userFlow(): El[] {
  seq = 0;
  const steps = ["Visits the site", "Signs up", "Confirms email", "Creates a project", "Invites the team"];
  const out: El[] = [text(0, -70, "Sign up flow", 32)];
  steps.forEach((s, i) => {
    const x = i * 260;
    out.push(rect(x, 0, 200, 90, i === 0 || i === steps.length - 1 ? "#e5dbff" : "#d0ebff", { roughness: 0, strokeWidth: 1 }));
    out.push(text(x + 18, 32, s, 18));
    if (i < steps.length - 1) out.push(arrow(x + 204, 45, 52, 0));
  });
  out.push(base("diamond", 520, 170, 200, 120, { backgroundColor: "#fff3bf", roughness: 0, strokeWidth: 1 }));
  out.push(text(560, 218, "Email found?", 18));
  out.push(arrow(620, 92, 0, 74));
  return out;
}

const orgChart = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Team" }] },
    { type: "paragraph", content: [{ type: "text", text: "Who leads what. Edit the names on the left and the chart redraws." }] },
    { type: "diagram", content: [{ type: "text", text: "flowchart TD\n  CEO[Alex, CEO]\n  CEO --> OPS[Sam, Operations]\n  CEO --> FIN[Priya, Finance]\n  CEO --> SAL[Mia, Sales]\n  OPS --> S1[Jo, Support]\n  OPS --> S2[Lee, Delivery]\n  SAL --> S3[Ravi, Accounts]" }] },
    { type: "paragraph" },
  ],
};

export const VISUAL_STARTERS = [
  { id: "starter-retro-board", kind: "doc" as const, name: "Retro board", category: "Docs", description: "A whiteboard with Went well, To improve and Actions columns, ready for sticky notes.", data: { title: "Sprint retro", content: whiteboardDocContent(JSON.stringify(retro())) } },
  { id: "starter-user-flow", kind: "doc" as const, name: "User flow", category: "Docs", description: "A whiteboard with the steps a person takes, joined by arrows, and a decision.", data: { title: "User flow", content: whiteboardDocContent(JSON.stringify(userFlow())) } },
  { id: "starter-org-chart", kind: "doc" as const, name: "Org chart", category: "Docs", description: "A diagram of who leads what, drawn from a few lines of text you can edit.", data: { title: "Org chart", content: orgChart } },
];
