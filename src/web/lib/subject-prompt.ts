/**
 * Mail with no subject is more likely to land in spam. Compose asks once ("Add a subject?") and never
 * blocks: pressing Send again, or "Send anyway", sends it as it is.
 */
export const SUBJECT_PROMPT = "Add a subject? Mail without one is more likely to go to spam.";

/** Whether pressing Send should show the prompt instead of sending. */
export function shouldAskForSubject(subject: string, alreadyAsked: boolean): boolean {
  return !alreadyAsked && subject.trim() === "";
}
