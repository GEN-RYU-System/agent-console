# v0.7.0 Routine Tasks — Recon

## Evidence

- `server/sessions.ts` is the configured-role PTY lifecycle and sole terminal write path.
- `server/hub.ts` has fresh `Hub.checkInput`; it re-fetches Claude state before input.
- `server/session-store.ts` defines serialized tmp → chmod 0600 → rename persistence.
- `server/restore.ts` records ordinary running sessions; routine sessions are excluded.
- `server/http.ts` places authenticated JSON routes under existing Host/Origin/auth handling.
- `src/pages/ConsolePage.tsx` and existing forms use registered Sales Anchor components.

## Acceptance criteria

`routines.json` is the sole routine SSOT; malformed files are not overwritten. JST weekday/minute scheduling evaluates a matching slot once, performs a fresh guard, records exactly one event, and does not retry or catch up. Dedicated sessions are never written to `open-sessions.json` and restore only from their exact persisted fields. No browser automation, external APIs, AppleScript, cron, deletion or automatic stop is in scope.
