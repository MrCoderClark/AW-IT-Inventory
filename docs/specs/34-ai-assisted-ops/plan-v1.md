# Spec 34 v1 — Implementation Plan

> Agent: execute task-by-task. Prefer TDD for pure helpers (config, redact, parse).

**Goal:** Optional AI assist on Computer detail — summarize health/failures/script runs; draft PowerShell for human Save/Run via spec 32.

**Architecture:** Web-only gateway. `AiProvider` (`noop` | `openai_compatible`). Redacted context pack → structured JSON response. Audit hash only.

**Tech:** Next.js route handler, Drizzle `ai_assist_events`, env config.

## Tasks

1. ~~Schema `aiAssistEvents` + env example keys + `lib/ai/config.ts` + providers~~
2. ~~`buildComputerContextPack` + redact/hash helpers + tests~~
3. ~~`runAssist` + `POST /api/ai/assist` + audit write~~
4. ~~Computer **Assist** panel (hidden when noop); draft → `/scripts` via sessionStorage~~
5. ~~Mark spec status Accepted (v1 implementing)~~

## Global constraints

- No AI auto-run / WinRM / deploy
- No secrets in packs
- `asset:read` summaries; `software:deploy` for draft_script
- App works with AI off
