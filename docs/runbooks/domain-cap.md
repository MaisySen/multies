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
