# v0.7.0 Routine Tasks — Design

## SSOT and lifecycle

`dataDir/routines.json` is the only persisted routine source (`server/routines.ts`). It contains identity, role/cwd/optional branch, `Asia/Tokyo`, weekdays/time, prompt, optional Claude UUID, timestamps and events. `open-sessions.json` excludes `Session.routineId` (`server/restore.ts`). The routine-to-live-session map, current Claude state and evaluated slots are memory-only.

Registration validates configured roles and the normal main/worktree cwd boundary, then starts one marked dedicated session. Startup restores that same role, cwd, branch and Claude UUID—never a substitute. Enable/disable controls eligibility only; deletion and automatic session stop are excluded.

## Dispatch boundary

`jstSlot` evaluates the Asia/Tokyo weekday and HH:mm. The scheduler marks a slot before dispatch, so each slot produces at most one result and never retries/catches up. Immediately before PTY write, `Hub.checkInput` gets a fresh verdict. Only idle/no-waiting input receives `promptText + "\r"`; busy, waiting, unknown, stopped, missing and failures create one event.

## Maintenance

The authenticated routes expose list/create/edit/enable only. The UI uses registered Sales Anchor components and Japanese strings in `src/locales/ja.json`; CSS uses existing tokens. Schema changes require parser and atomic-write tests; scheduling changes must retain deterministic JST, evaluated-before-dispatch, and fresh-guard tests. Validate releases with lint, typecheck, unit tests, build and Playwright e2e.
