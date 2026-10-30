// Generates src/components/icon-paths.ts: the SVG paths of the app's icons, by name.
// iOS and web: Phosphor (MIT, regular and fill weights, 256 grid, the closest open set to SF Symbols).
// Android: Material Symbols Rounded (Apache 2.0, weight 400, outline and fill, 960 grid).
// Usage: npm pack @phosphor-icons/core @material-symbols/svg-400, untar each, then
//   node scripts/gen-icons.mjs <phosphor package dir> <material symbols package dir>
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export const MAP = {
  "activity": ["pulse", "vital_signs"],
  "alarm-clock": ["alarm", "alarm"],
  "alert-circle": ["warning-circle", "error"],
  "archive": ["archive", "archive"],
  "arrow-right": ["arrow-right", "arrow_forward"],
  "at-sign": ["at", "alternate_email"],
  "bell": ["bell", "notifications"],
  "bot": ["robot", "smart_toy"],
  "briefcase": ["briefcase", "work"],
  "calendar": ["calendar-blank", "calendar_today"],
  "check": ["check", "check"],
  "check-circle": ["check-circle", "check_circle"],
  "check-square": ["check-square", "check_box"],
  "chevron-down": ["caret-down", "keyboard_arrow_down"],
  "chevron-left": ["caret-left", "chevron_left"],
  "chevron-right": ["caret-right", "chevron_right"],
  "chevron-up": ["caret-up", "keyboard_arrow_up"],
  "circle": ["circle", "radio_button_unchecked"],
  "circle-stop": ["stop-circle", "stop_circle"],
  "clock": ["clock", "schedule"],
  "command": ["command", "keyboard_command_key"],
  "columns": ["kanban", "view_kanban"],
  "compass": ["compass", "explore"],
  "copy": ["copy", "content_copy"],
  "corner-down-right": ["arrow-elbow-down-right", "subdirectory_arrow_right"],
  "corner-up-left": ["arrow-bend-up-left", "reply"],
  "corner-up-right": ["arrow-bend-up-right", "forward"],
  "cpu": ["cpu", "memory"],
  "dollar-sign": ["currency-dollar", "attach_money"],
  "download": ["download-simple", "download"],
  "edit": ["note-pencil", "edit_square"],
  "edit-3": ["pencil-simple", "edit"],
  "external-link": ["arrow-square-out", "open_in_new"],
  "eye": ["eye", "visibility"],
  "file-text": ["file-text", "description"],
  "filter": ["funnel", "filter_alt"],
  "flag": ["flag", "flag"],
  "globe": ["globe", "language"],
  "grip-vertical": ["dots-six-vertical", "drag_indicator"],
  "hard-drive": ["hard-drives", "hard_drive"],
  "hash": ["hash", "tag"],
  "inbox": ["tray", "inbox"],
  "info": ["info", "info"],
  "key": ["key", "key"],
  "layers": ["stack", "layers"],
  "life-buoy": ["lifebuoy", "support"],
  "link": ["link", "link"],
  "list": ["list", "list"],
  "lock": ["lock", "lock"],
  "log-out": ["sign-out", "logout"],
  "mail": ["envelope-simple", "mail"],
  "mail-open": ["envelope-simple-open", "drafts"],
  "map-pin": ["map-pin", "location_on"],
  "message-circle": ["chat-circle", "chat_bubble"],
  "message-square": ["chat-centered-text", "chat"],
  "minus": ["minus", "remove"],
  "moon": ["moon", "dark_mode"],
  "more-horizontal": ["dots-three", "more_horiz"],
  "paperclip": ["paperclip", "attach_file"],
  "pause": ["pause", "pause"],
  "play": ["play", "play_arrow"],
  "plus": ["plus", "add"],
  "refresh-cw": ["arrows-clockwise", "refresh"],
  "search": ["magnifying-glass", "search"],
  "send": ["paper-plane-tilt", "send"],
  "settings": ["gear", "settings"],
  "shield": ["shield-check", "shield"],
  "sliders": ["sliders-horizontal", "tune"],
  "smartphone": ["device-mobile", "mobile"],
  "square": ["square", "check_box_outline_blank"],
  "star": ["star", "star"],
  "sun": ["sun", "light_mode"],
  "tag": ["tag", "sell"],
  "trash-2": ["trash", "delete"],
  "undo": ["arrow-counter-clockwise", "undo"],
  "user": ["user", "person"],
  "user-check": ["user-check", "how_to_reg"],
  "user-x": ["user-minus", "person_remove"],
  "users": ["users", "group"],
  "video": ["video-camera", "videocam"],
  "wifi-off": ["wifi-slash", "wifi_off"],
  "x": ["x", "close"],
  "zap": ["lightning", "bolt"],
  "tasks": ["check-square-offset", "task_alt"],
  "chat": ["chats-circle", "forum"],
  "compose": ["note-pencil", "edit_square"],
  "snooze": ["alarm", "snooze"],
  "trash": ["trash", "delete"],
  "more": ["dots-three", "more_horiz"],
  "back": ["caret-left", "arrow_back_ios_new"],
  "today": ["sun", "today"],
  "home": ["house", "home"],
  "sparkle": ["sparkle", "star_shine"],
  "meeting": ["video-camera", "videocam"],
  "mention": ["at", "alternate_email"],
  "approvals": ["seal-check", "verified"],
  "activity-bell": ["bell-simple", "notifications"],
  "overdue": ["warning", "warning"],
  "pin": ["push-pin", "keep"],
  "read": ["envelope-simple-open", "drafts"],
  "unread": ["envelope-simple", "mark_email_unread"],
  "priority": ["flag-banner", "flag"],
  "project": ["folder-simple", "folder"],
  "assign": ["user-plus", "person_add"],
  "move": ["arrow-square-right", "drive_file_move"],
  "due": ["calendar-check", "event_available"],
  "doc": ["file-text", "description"],
};

const [phos, mat] = process.argv.slice(2);
if (!phos || !mat) { console.error("usage: node scripts/gen-icons.mjs <phosphor dir> <material dir>"); process.exit(1); }
const paths = (file) => {
  if (!existsSync(file)) throw new Error(`missing ${file}`);
  return [...readFileSync(file, "utf8").matchAll(/ d="([^"]+)"/g)].map((m) => m[1]).join(" ");
};
const out = {};
for (const [name, [p, m]] of Object.entries(MAP)) {
  out[name] = [
    paths(`${phos}/assets/regular/${p}.svg`), paths(`${phos}/assets/fill/${p}-fill.svg`),
    paths(`${mat}/rounded/${m}.svg`), paths(`${mat}/rounded/${m}-fill.svg`),
  ];
}
const body = Object.entries(out).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n");
writeFileSync(new URL("../src/components/icon-paths.ts", import.meta.url), `// Generated by scripts/gen-icons.mjs. Do not edit by hand.
// Each entry: [iOS regular, iOS fill, Android outline, Android fill].
// iOS and web: Phosphor Icons (MIT). Android: Material Symbols Rounded (Apache 2.0).
export const ICON_PATHS = {
${body}
} as const;
`);
console.log(`${Object.keys(out).length} icons`);
