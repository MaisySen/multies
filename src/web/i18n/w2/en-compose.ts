/**
 * R104B (LANG_R104): the English source for the compose pages. It ships in those pages' own chunk (not the main entry) and
 * joins the English bundle when the page loads. Add a key here first, then its Nepali and Hindi in w2/ne.ts and w2/hi.ts.
 */
import { addEnglish } from "../index";

export const enCompose = {
  "compose.a_share_link_suits_bigger_files": "A share link suits bigger files.",
  "compose.applying_your_rule": "Applying your rule",
  "compose.attach_files": "Attach files",
  "compose.attach_files_your_rules_run_before_sending": "Attach files (your rules run before sending)",
  "compose.attachments": "Attachments",
  "compose.attachments_can_add_up_to_compose_attach_max_byt": "Attachments can add up to {COMPOSE_ATTACH_MAX_BYTES} in one email.",
  "compose.bcc": "Bcc",
  "compose.can_t_go_out_verify_the_domain_or_pick_another_f": "can't go out. Verify the domain or pick another From address.",
  "compose.cc": "Cc",
  "compose.cc_bcc": "Cc Bcc",
  "compose.couldn_t_schedule_it": "Couldn't schedule it.",
  "compose.couldn_t_send": "Couldn't send.",
  "compose.expand": "Expand",
  "compose.find_it_in_scheduled_to_edit_or_cancel_it": "Find it in Scheduled to edit or cancel it.",
  "compose.from_tools": "From Tools",
  "compose.isn_t_verified_yet_so_mail_from": "isn't verified yet, so mail from",
  "compose.minimize": "Minimize",
  "compose.not_saved_yet": "Not saved yet",
  "compose.pick_another_from_address_or_verify_the_domain_f": "Pick another From address, or verify the domain first.",
  "compose.queued_until_tomorrow": "Queued until tomorrow",
  "compose.remove_name": "Remove {name}",
  "compose.saved_to_sent_not_delivered_outside_yet": "Saved to Sent, not delivered outside yet",
  "compose.saving": "Saving",
  "compose.send_it_now_or_remove_the_files_to_schedule_it": "Send it now, or remove the files to schedule it.",
  "compose.undo": "Undo",
  "compose.verify_name_before_sending_from_it": "Verify {name} before sending from it.",
  "compose.write_your_message": "Write your message…",
  "compose.your_message_is_back_in_compose": "Your message is back in Compose.",
} as const;
addEnglish(enCompose);
