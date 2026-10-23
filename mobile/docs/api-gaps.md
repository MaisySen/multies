# What the API is missing for mobile

Updated for round 6 (app 1.1.0). The tasks API, push device registration, the sync cursor and
notifications are now on the API, and the app uses them. The demo (`POST /api/account/demo`) now
answers in a few seconds on production.

## Still open (nice to have, nothing blocks the app)

- `GET /api/changes?since=` covers tasks and the suite, not mail. A mail change feed would let the
  app sync only what changed instead of refetching the first page of each folder.
- Better Auth's `bearer` plugin would let the app use an `Authorization` header instead of a
  cookie. The cookie approach works today and needs no change.
- The approval review screen loads the whole approvals list to show one item. A
  `GET /api/approvals/:id` would make a tapped push open faster.
- `GET /api/tasks/:id` returns the task's thread with `latestText` per message, which is all the
  task screen needs. Attachments on those messages are only visible from the thread screen.
