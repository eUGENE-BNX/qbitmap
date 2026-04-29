# Schema Decisions

Notes on schema-level design choices that aren't self-evident from
reading the SQL. Anything here is a deliberate trade-off, not a bug.

## Soft-delete vs cascade

`users.is_active TINYINT(1) DEFAULT 1` is a soft-delete flag. Most
foreign keys that reference `users(id)` use `ON DELETE CASCADE` or
`ON DELETE SET NULL`, but those clauses only fire on a *hard* DELETE,
not on `UPDATE users SET is_active=0`.

This is intentional:

- **A deactivated user's content stays.** Comments, likes, video
  messages, and shared cameras are visible to other users; deleting
  them when one party deactivates would surface "ghost" replies and
  broken threads to everyone else.
- **Reactivation is reversible.** A user who deactivates and changes
  their mind can be flipped back to `is_active=1` with their data
  intact.
- **Audit trail is preserved.** `audit_log.user_id` keeps pointing to
  the row even after deactivation, so admin investigations of a
  former user's actions still resolve.

The trade-off: query helpers must check `is_active=1` whenever they
materialize a user (login, profile lookup, share-target picker).
This is enforced today via `services/db/users.js` getters; new
queries that join `users` should follow the same pattern.

A future cleanup job (out of scope for launch) can hard-delete users
who stayed `is_active=0` for >180 days, at which point the existing
`ON DELETE CASCADE` clauses do tidy the residual content.

## alarm_data column type — TEXT → JSON (2026-04-29)

`alarms.alarm_data` was originally `TEXT`. Migrated to native
`JSON` so mysql2 parses on SELECT — saves a per-row JSON.parse on
every alarm-list response and gives MySQL row-level validation that
inserted payloads are well-formed JSON. Existing rows were valid
JSON because `createAlarm()` always stringifies before insert; the
ALTER would have failed loudly if any row was malformed.

## Migration runner `;` trap

`db.ensureReady()` runs `migrations/*.sql` files split on `;`. That
means a semicolon **inside a SQL comment** is treated as a statement
terminator and chops the comment in half (caught the hard way on
`2026-04-29_alarm_data_json.sql`'s first deploy). Until the runner
is upgraded to a proper SQL tokenizer:

- Don't use `;` or other statement-terminating punctuation in
  migration comments.
- Don't use `.` at sentence ends inside comments either — it's
  visually safe but trains people to write multi-sentence comments
  that eventually grow a `;`.
- One `;` per real statement, at the very end.

If you need a multi-statement migration, split it into one statement
per file with a numeric suffix (`_part1.sql`, `_part2.sql`).
