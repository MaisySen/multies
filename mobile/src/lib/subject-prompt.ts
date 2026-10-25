import { Alert } from "react-native";

/**
 * A gentle check before sending mail with no subject. It never blocks the send: the person can
 * add a subject or send anyway. Mail without a subject is more likely to be filtered as spam.
 */
export const EMPTY_SUBJECT_PROMPT = {
  title: "Add a subject?",
  message: "Mail without one is more likely to go to spam.",
  add: "Add subject",
  send: "Send anyway",
} as const;

/** True when the subject is empty or only spaces. */
export function needsSubjectPrompt(subject: string | null | undefined): boolean {
  return !(subject ?? "").trim();
}

type AlertFn = typeof Alert.alert;

/** Shows the prompt. Resolves true for Send anyway, false for Add subject or a dismissed dialog. */
export function askAboutEmptySubject(alert: AlertFn = Alert.alert): Promise<boolean> {
  return new Promise((resolve) => {
    alert(
      EMPTY_SUBJECT_PROMPT.title,
      EMPTY_SUBJECT_PROMPT.message,
      [
        { text: EMPTY_SUBJECT_PROMPT.add, style: "cancel", onPress: () => resolve(false) },
        { text: EMPTY_SUBJECT_PROMPT.send, onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
