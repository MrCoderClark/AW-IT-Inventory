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
