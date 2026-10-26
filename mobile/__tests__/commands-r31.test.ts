import { COMMANDS, COMMAND_IDS, MAIL_MENU, TASK_MENU, TRIAGE_MENU, command, commandTitle, commandsFor, createHandlers, searchCommands, type CommandDeps } from "@/lib/commands";
import { ICONS } from "@/components/icons";

function deps() {
  const calls: unknown[][] = [];
  const rec = (name: string) => (...a: unknown[]) => { calls.push([name, ...a]); };
  const d: Required<CommandDeps> = {
    navigate: rec("navigate"), openWeb: rec("openWeb"), pickTaskField: rec("pickTaskField"), mail: rec("mail"),
    pickSnooze: rec("pickSnooze"), triage: rec("triage"), cancelRun: rec("cancelRun"),
  };
  return { d, calls };
}
const ctx = { taskId: "tsk_1", messageId: "msg_1", notificationId: "ntf_1", runId: "run_1", starred: false, read: true };

describe("R31 command registry", () => {
  it("ids are unique and every listed id has exactly one command", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...COMMAND_IDS].sort());
  });

  it("every command has a handler, and each handler does something", () => {
    const { d, calls } = deps();
    const handlers = createHandlers(d);
    expect(Object.keys(handlers).sort()).toEqual([...COMMAND_IDS].sort());
    for (const c of COMMANDS) {
      const before = calls.length;
      handlers[c.id](ctx);
      expect(calls.length).toBe(before + 1);
    }
  });

  it("handlers without the needed context do nothing (no crash, no wrong target)", () => {
    const { d, calls } = deps();
    const handlers = createHandlers(d);
    for (const id of [...TASK_MENU, ...MAIL_MENU.filter((x) => x !== "mail-reply"), ...TRIAGE_MENU, "run-cancel" as const]) handlers[id]({});
    expect(calls).toEqual([]);
  });

  it("titles, icons and the web keys line up with the web app", () => {
    for (const c of COMMANDS) {
      expect(ICONS[c.icon]).toBeTruthy();
      expect(c.title).not.toMatch(/[\u2013\u2014]/);
    }
    expect(command("go-i").title).toBe("Go to Mail");
    expect(command("mail-archive").web).toEqual(["E"]);
    expect(command("mail-trash").web).toEqual(["#"]);
    expect(command("compose").title).toBe("Write an email");
    expect(commandsFor("go").map((c) => c.web?.join(""))).toEqual(["GI", "GT", "GD", "GC", "GM", "GN"]);
  });

  it("toggle titles read as the action they will do", () => {
    expect(commandTitle("mail-star", { starred: true })).toBe("Unstar");
    expect(commandTitle("mail-star", { starred: false })).toBe("Star");
    expect(commandTitle("mail-read", { read: true })).toBe("Mark unread");
    expect(commandTitle("mail-read", { read: false })).toBe("Mark read");
    expect(commandTitle("mail-star")).toBe("Star or unstar");
  });

  it("star and read handlers flip the current state", () => {
    const { d, calls } = deps();
    const h = createHandlers(d);
    h["mail-star"]({ messageId: "m", starred: true });
    h["mail-read"]({ messageId: "m", read: false });
    h["mail-reply"]({ messageId: "m" });
    h["go-d"]({});
    expect(calls).toEqual([["mail", "unstar", "m"], ["mail", "read", "m"], ["navigate", { pathname: "/compose", params: { replyTo: "m" } }], ["openWeb", "/app/docs"]]);
  });

  it("menus list registry commands in the agreed order", () => {
    expect(TASK_MENU.map((id) => commandTitle(id))).toEqual(["Change status", "Assign to", "Set priority", "Add a label", "Set due date"]);
    expect(MAIL_MENU.map((id) => command(id).title)).toEqual(["Reply", "Archive", "Snooze", "Star or unstar", "Mark read or unread", "Move to trash"]);
  });

  it("search matches titles and keywords, best first", () => {
    expect(searchCommands("")).toHaveLength(commandsFor(["go", "app"]).length);
    expect(searchCommands("tas")[0].id).toBe("go-t");
    expect(searchCommands("compose").map((c) => c.id)).toContain("compose");
    expect(searchCommands("triage").map((c) => c.id)).toEqual(["go-n"]);
    expect(searchCommands("zzzz")).toEqual([]);
  });
});
