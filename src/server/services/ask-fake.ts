/**
 * R110: a stand in for the AI in end to end tests only. node.ts wires it when ASK_AI_FAKE=1 and APP_URL is
 * localhost or 127.0.0.1; it is never wired into the Worker. It answers from the first source, deterministically.
 */
import type { AiRunner } from "./tools/p2-bindings";

export function fakeAskAllowed(env: { ASK_AI_FAKE?: string; APP_URL?: string }) {
  if (env.ASK_AI_FAKE !== "1") return false;
  try { const h = new URL(env.APP_URL ?? "").hostname; return h === "localhost" || h === "127.0.0.1"; } catch { return false; }
}

export const fakeAskAi: AiRunner = {
  async run(_model: string, input: unknown) {
    const msgs = (input as { messages?: { role: string; content: string }[] }).messages ?? [];
    const user = msgs.find((m) => m.role === "user")?.content ?? "";
    const question = (/Question: (.*)$/s.exec(user)?.[1] ?? "").toLowerCase();
    const first = /\[1\] ([^:\n]+): ([^\n]*)/.exec(user);
    const lines = [first ? `From ${first[1].toLowerCase()} "${first[2].replace(/ \(.*\)$/, "")}": this is the answer [1].` : "I could not find it."];
    if (first && /\b(mark|done|finish|complete)\b/.test(question) && first[1] === "Task") lines.push("ACTION task_status 1 done");
    if (first && /\bwon\b/.test(question) && first[1] === "Deal") lines.push("ACTION deal_stage 1 won");
    if (/\b(create|add)\b/.test(question)) lines.push("ACTION task_create Follow up from Ask");
    return { response: lines.join("\n"), usage: { prompt_tokens: 200, completion_tokens: 30 } };
  },
} as AiRunner;
