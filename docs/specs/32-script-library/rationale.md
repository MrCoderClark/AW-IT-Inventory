# 32. Script library — rationale

## Why a library instead of only the remote terminal?

Spec 24 is interactive REPL — great for exploration, poor for “run this known
fix every week.” A library freezes approved text, audits runs, and reuses the
same outbound job queue as deploy/patch install.

## Why not piggyback software-deploy script steps?

Deploy packages are installer-centric (files + hashes). Scripts are text-first
and need their own list UI and history. Sharing the queue *machinery* is enough;
sharing the *table* would muddle “push Chrome” with “clear print spooler.”

## Why one computer in v1?

Fan-out and schedules multiply blast radius. Prove claim → WinRM → result on one
host first (same sequencing as patch install).

## Why reuse `software:deploy`?

Same people already push software and patches. A separate `script:write` is
easy to add later if roles diverge; v1 avoids RBAC churn.

## Why freeze the body at enqueue?

Editing the library after Run must not change an in-flight job (same rule as
packageSnapshot on deployments).

## Why batch + per-host jobs (v2)?

A mega-job that fans out inside the worker hides per-host status and fights the
existing claim/reaper model. One `script_run_batches` row + N `script_run_jobs`
keeps the v1 runner unchanged and lets history stay per computer.

## Why schedules live in web (v2)?

Same pattern as report delivery (spec 26): web owns `nextRunAt`, the worker only
ticks. No cron DSL on the collector; daily/weekly wall-clock is enough for IT
ops, and `computeNextRun` is already proven.
