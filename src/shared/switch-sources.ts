/**
 * R58 (MB-237): the public switch pages, one per work tool the import really reads today
 * (services/work-import/parse.ts; the picker in pages/app/data-move.tsx uses the same ids).
 * Pure data, so the router, the 404 list, the page titles, the sitemap test and the pages share it.
 * A tool's name appears here only because a visitor needs it to find their own export.
 */
export interface SwitchSource {
  /** The URL part (/switch/<slug>) and the import picker id (/app/settings/import?source=<slug>). */
  slug: string;
  label: string;
  /** What the export file is, in plain words. */
  file: string;
  /** The sample file under public/samples/, made up data in the same shape as a real export. */
  sample: string;
  /** What comes across, one short line each. */
  moves: string[];
  /** How to get the export out of the tool, in order. */
  steps: string[];
}

export const SWITCH_SOURCES: SwitchSource[] = [
  {
    slug: "trello", label: "Trello", file: "a board JSON file", sample: "/samples/trello-board.json",
    moves: ["Cards become tasks, lists become statuses", "Checklists stay with their cards", "Labels, due dates and members", "Comments on each card"],
    steps: ["Open the board you want to bring over.", "Open the board menu, then Print, export and share.", "Choose Export as JSON and save the file."],
  },
  {
    slug: "asana", label: "Asana", file: "a project CSV file", sample: "/samples/asana-project.csv",
    moves: ["Tasks, with sections as statuses", "Subtasks stay under their parent", "Assignees, start and due dates", "Tags as labels, notes as descriptions"],
    steps: ["Open the project.", "Click the arrow next to the project name.", "Choose Export, then CSV, and save the file."],
  },
  {
    slug: "clickup", label: "ClickUp", file: "a list CSV file", sample: "/samples/clickup-list.csv",
    moves: ["Tasks with status and priority", "Subtasks under their parent", "Assignees, tags, start and due dates", "Comments and checklists"],
    steps: ["Open the list in List view.", "Open the view menu and choose Export view.", "Pick CSV with all columns and save the file."],
  },
  {
    slug: "jira", label: "Jira", file: "an issues CSV file", sample: "/samples/jira-issues.csv",
    moves: ["Issues with their status category", "Sub tasks under their parent", "Priority, labels and due dates", "Descriptions and comments"],
    steps: ["Search for the work items you want.", "Choose Export, then Export CSV (all fields).", "Save the file."],
  },
  {
    slug: "monday", label: "monday.com", file: "a board Excel or CSV file", sample: "/samples/monday-board.csv",
    moves: ["Items become tasks, groups come too", "Subitems under their parent item", "Person, status, date and priority", "Notes as descriptions"],
    steps: ["Open the board.", "Open the three dots menu, then More actions.", "Choose Export board to Excel and save the file."],
  },
  {
    slug: "notion", label: "Notion", file: "a Markdown and CSV zip, or the CSV", sample: "/samples/notion-database.csv",
    moves: ["Database rows become tasks", "Each row's page becomes its description (from the zip)", "Status, assignee, due date and tags", "Priority"],
    steps: ["Open the database as a full page.", "Open the three dots menu and choose Export.", "Pick Markdown and CSV and save the zip."],
  },
  {
    slug: "todoist", label: "Todoist", file: "a project CSV file", sample: "/samples/todoist-project.csv",
    moves: ["Tasks, with sections as statuses", "Indented tasks become subtasks", "Notes become comments", "Priority, assignee and dates"],
    steps: ["Open the project.", "Open the three dots menu, then Manage data.", "Choose Export as CSV and save the file."],
  },
  {
    slug: "linear", label: "Linear", file: "an issues CSV file", sample: "/samples/linear-issues.csv",
    moves: ["Issues with their status", "Sub issues under their parent", "Assignee, priority, labels and due dates", "Descriptions"],
    steps: ["Open Settings, then Administration.", "Choose Import and export, then Export data.", "Save the CSV it sends you."],
  },
];

export const SWITCH_SLUGS = SWITCH_SOURCES.map((s) => s.slug);

export function switchSource(slug: string | undefined | null): SwitchSource | null {
  return SWITCH_SOURCES.find((s) => s.slug === slug) ?? null;
}

/** The import screen with the tool picked. */
export const importPathFor = (slug: string) => `/app/settings/import?source=${encodeURIComponent(slug)}`;

/** Signed out visitors create an account first and then land on the import screen. */
export const startImportHref = (slug: string, signedIn: boolean) =>
  signedIn ? importPathFor(slug) : `/signup?next=${encodeURIComponent(importPathFor(slug))}`;

/** The download name for a sample, for example "trello-board-sample.json". */
export const sampleFileName = (s: SwitchSource) => s.sample.split("/").pop()!.replace(/(\.[a-z]+)$/, "-sample$1");
