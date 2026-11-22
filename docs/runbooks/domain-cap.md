# The sending provider's domain cap

Round 17, 25 October 2026.

The sending provider's free plan counts the domains registered on the account (production: `multies.si` for Multies' own system mail, and `haajir.xyz`). A full plan must never break sign up or adding a domain:

- A customer domain is registered with the provider when it is added. When the provider answers that the plan is full, the domain is kept with the status `queued:` and the provider's words, instead of an error (`services/mail/provider-domains.ts`).
- The domain page says "In the queue for a sending slot". The domain is saved, receives mail, and mail between Multies addresses works. Sending to outside addresses waits.
- Mail is never sent under another domain's name. Customers never get an address or a sender on `multies.si`, which is Multies' own company domain for its staff addresses (support@, hello@ and the rest). Owner decision, 25 October 2026.
- The oldest queued domain is offered the next slot on every maintenance pass and right after any domain leaves Multies (`retryQueuedProviderDomains` in `services/domains.ts`). Nothing is written while the plan stays full.

## Free option, and when to pay

Staying free: keep the queue. People can sign up, add their domain, publish DNS and receive from day one; outside sending starts when a slot frees.

More slots need a paid sending plan, which needs a card and is an owner decision. Nothing in the code changes: raise the plan, and the queue drains by itself on the next maintenance pass.

## Daily sending caps, the queue and the kill switch (R34, MB-166 and MB-169)

The sending provider's free plan also has one daily allowance (100 a day) shared by every Multies workspace, Multies' own sign-in mail and Haajir. The send path (`services/mail/send-guard-r34.ts`) protects it, and never drops a message:

- **Per workspace cap.** The plan's daily recipients (an operator can lower it with Set cap). At 80% and at 100% the workspace's billing contacts get one notice each per day, and ops (SUPPORT_EMAIL) gets at most one mail per workspace per day.
- **New sender limit.** A new workspace sends to 20 outside recipients a day for its first 7 days (`NEW_SENDER_DAILY_SENDS`, `NEW_SENDER_DAYS`). After that the plan cap applies, unless the last 7 days had more than 4% bounces (the sending provider pauses an account over 4%) or any spam complaint, which keeps it at 20.
- **Shared headroom.** Person mail to outside addresses stops for the day once 90 messages went out through the provider today, counting every workspace and system mail (`MAIL_PROVIDER_DAILY_CAP` 100, `MAIL_PROVIDER_HOLD_AT` 90; a cap of 0 turns this off). Sign-in codes and password resets are system mail and never pass this check, so they always have the last 10. Haajir's own sends aren't in Multies' count: if Haajir sends more than about 10 a day, lower `MAIL_PROVIDER_HOLD_AT`.
- **Queue.** Over any of these, the message is kept as a scheduled send due at midnight UTC with the reason. The sender sees "Queued until tomorrow" and the reason, and the message sits in Scheduled. If it is still over a limit at midnight, it waits another day. Agents keep the old refusal.
- **Send anyway.** Operator console (`/console/workspaces`, open the workspace), Queued: lists the held messages; Send anyway makes one due now and the next schedules pass sends it past the limits (audited as `message.queued_send_forced`).
- **Kill switch.** Operator console (`/console/workspaces`, open the workspace), Sending on/off (`PUT /api/console/workspaces/{id}/sending` with a reason). Off sets the workspace's cap to 0: every send is refused with "Sending is turned off for this workspace..." (403 `sending_off`), nothing is queued. On returns it to the plan's cap. Both are audited.
- **Spam score.** Unchanged thresholds (6 flags for review, 10 holds), plus two signals: 10 or more first-time outside recipients in one message (+2) and a body that is only a link (+3).

Raising the shared allowance needs a paid sending plan (an owner decision). Then raise `MAIL_PROVIDER_DAILY_CAP` and `MAIL_PROVIDER_HOLD_AT`.
