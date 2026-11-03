/**
 * WEB1: the public AI wording in one place, so the site never claims an AI feature before it is live on prod.
 *
 * BUILT_IN_AI_LIVE: set true only once AI2 (free built in AI with a daily allowance that never bills) is live on prod.
 * TEAM_AI_LIVE: set true only once TD8 (Team AI) is live on prod.
 * Whoever ships those rounds flips the value; the pricing FAQ and the privacy policy follow.
 */
export const BUILT_IN_AI_LIVE = true; // AI2 live on prod 7c4696056b64 (Nov 2)
export const TEAM_AI_LIVE = true; // TD8 live on prod 85cc035064fa (Nov 2)

export function aiCostAnswer(builtIn: boolean = BUILT_IN_AI_LIVE, teamAi: boolean = TEAM_AI_LIVE): string {
  const team = teamAi ? " Team AI gets 50 free runs a day per workspace on built in AI, with no run limit from us on your own key." : "";
  return builtIn
    ? `Nothing from us. Every workspace gets a daily allowance of built in AI at no cost, and when it is used up AI pauses until the next day, so it never bills you.${team} For more, add your own model provider key in Settings and your provider bills you directly. You can also connect any AI app or agent through MCP, free. An admin can turn AI off for the whole workspace.`
    : "Nothing from us. Bring your own AI: connect any AI app or agent through MCP, free. If you want the assistant in the inbox, add your own model provider key in Settings and your provider bills you directly. Multies never resells AI.";
}

/** The AI section of the privacy policy. Only statements true on prod today; the built in line joins once AI2 is live. */
export function aiPrivacyBlocks(builtIn: boolean = BUILT_IN_AI_LIVE, teamAi: boolean = TEAM_AI_LIVE): string[] {
  return [
    "AI features in Multies are optional. A workspace admin can turn AI off for the whole workspace in Settings; while it is off, nothing is sent to any AI service.",
    "We do not use your content to train AI models, and the AI services we use do not keep it after the answer.",
    "Answers from Ask your workspace use only the items the person asking is allowed to open, and show where each answer came from.",
    ...(builtIn ? ["Built in AI runs on our infrastructure provider's AI service. It is free: each workspace has a daily allowance, and when it is used up AI pauses until the next day. It never bills you or your workspace."] : []),
    ...(teamAi ? ["Team AI keeps the memory and instructions your team gives it inside your workspace, where admins can see, edit and delete them."] : []),
    "If your workspace adds its own AI key, the text you ask about goes to the provider your workspace chose, on your account with them and under their terms. Keys are stored encrypted and never shown in full again.",
  ];
}
