# 28. RMM roadmap — "Atera-like" gap analysis & plan

> **Status: roadmap / decision doc.** This is not a feature spec — it scopes *what*
> to build and *in what order* so the team can decide. Each capability we choose
> becomes its own numbered spec (29, 30, …). Nothing here commits the architecture.

## Purpose

H2Tecs today is a strong **agentless IT asset platform**: discovery + inventory,
device health/compliance, remote terminal, software deployment, printer management,
a reporting engine, people/assignments, and RBAC. The ask is to move it toward what
**Atera** offers. Atera is a full **RMM + PSA** suite, so "Atera-like" is a *program*
of features, not one build. This doc maps the territory and proposes an order.

## The decision that shapes everything: single-org vs. MSP

Atera is built for **MSPs** — one console managing *many* customers (multi-tenant),
with billing, contracts, and a customer-facing portal. H2Tecs today is **on-prem,
single-organization**. This fork must be decided first, because it changes the data
model, auth, and every screen:

| | **A. Internal-IT RMM** (stay single-org) | **B. Multi-tenant MSP** (go Atera's model) |
|---|---|---|
| Tenancy | one org, as today | `tenant_id` on everything; row-level isolation |
| Auth (aw-auth) | current RBAC | tenancy + per-tenant roles, cross-tenant admin |
| Deploy | on-prem single instance | SaaS multi-tenant (or per-tenant on-prem) |
| Scope of PSA | light/none (internal) | ticketing + billing + contracts + portal |
| Effort | incremental, builds on today | a large re-architecture before features |

**DECIDED: A — internal-IT RMM** (single-org, on-prem). Builds directly on everything
shipped and avoids a tenancy re-architecture; revisit B only if H2Tecs is ever sold to
other orgs. **Priority DECIDED: the RMM core first** — Spec 29 (metric monitoring) →
Spec 30 (alerting), ahead of ticketing.

## Capability matrix: Atera → what we have → the gap

| Atera area | H2Tecs today | Gap to close |
|---|---|---|
| **Discovery & inventory** | ✅ agentless scan (WinRM/SNMP/TLS), 5 asset types, discovered-devices inbox | minor: more device types, richer network topology |
| **Device health / monitoring** | 🟡 compliance posture (spec 21) — *current state only* | **metric history + thresholds + trend** (CPU/RAM/disk over time, "> 90% for 10 min") |
| **Alerting** | 🟡 compliance at-risk + printer reachability emails | general **alert rules engine** (any signal → condition → notify), escalation |
| **Patch management** | 🟡 software *deploy* (spec 23) | **OS + 3rd-party patch orchestration**: detect missing → approve → stage → report |
| **Automation / scripting** | 🟡 remote terminal (24) + deploy (23) | **reusable script library** run on schedule / on-alert across a device group |
| **Remote access** | ✅ remote terminal (spec 24, REPL) | optional: GUI remote (Splashtop/RustDesk-style) — big, maybe out of scope |
| **Reporting & analytics** | ✅ reporting engine + scheduled delivery (26) | charts/trend reports once metric history exists |
| **Software/license mgmt** | ✅ tracked software inventory (15) | license counts / expiry, usage |
| **Ticketing / helpdesk (PSA)** | ❌ none | full module: tickets, SLA, comments, email-in; **largest single build** |
| **Customer portal / billing / contracts** | ❌ none | only for MSP (fork B) — deprioritize under A |
| **Mobile app** | ❌ none | later; the web app is responsive already |

## Proposed spec order (under decision A)

Sequenced by value ÷ effort and by dependency (monitoring underpins alerting and
trend reporting). Numbers are indicative, not commitments.

1. **Spec 29 — Metric monitoring & history.** Collector samples CPU/RAM/disk/uptime
   on a cadence; store time-series (retention-pruned); device detail shows sparklines.
   *Foundation for alerting + trend reports. Builds on the existing scan/ingest + the
   spec-26 chart components.* **High value, medium effort.**
2. **Spec 30 — Alert rules engine.** A rule = signal + condition + severity +
   recipients (reuses the aw-auth notify path). Generalizes the spec-21/spec-12
   one-off alerts into a configurable engine; consumes spec-29 metrics + compliance.
   **High value, medium effort.**
3. **Spec 31 — Patch management.** ✅ **v1 shipped** — installed KBs + winget
   upgrades, daily missing Search, approve/install from Updates, one-host Check
   for updates. Fleet bulk / reboot-when-done / WSUS = v2 (see spec 31 out of
   scope).
4. **Spec 32 — Automation/script library.** Library + run-now (v1) + multi-target
   / daily·weekly schedules (v2). On-alert / parameters = later.
   **Medium value, medium effort.**
5. **Spec 33 — Ticketing / helpdesk.** ✅ **v1 specified** —
   [33](../33-ticketing/index.md): IT-only tickets + comments, create from
   notification, global auto-create by notification type. SLA / email-in /
   end-user portal / AI triage = later. **High value; phased.**
6. **Spec 34 — AI-assisted IT operations.** Optional technician assist (summaries,
   draft scripts for human approval). Pluggable providers; free cloud
   OpenAI-compatible first; app works with AI off. See
   [34](../34-ai-assisted-ops/index.md). **Medium value, medium effort; parallel
   to 33.**
7. **Later / optional:** license-expiry tracking, GUI remote access, mobile,
   network-topology mapping. **Fork B only:** multi-tenancy, customer portal, billing.

## How this maps to "do we need a new spec?"

Yes — but **this** doc first (the decision + the order), then **one spec per
capability** as we pick them up, exactly like specs 1–27. We don't need a single
giant spec; we need this roadmap plus small, shippable specs in sequence.

## Open questions (answer before spec 29)

- ~~The fork: A or B?~~ **DECIDED: A (internal-IT RMM).**
- ~~Priority: monitoring/alerting vs ticketing?~~ **DECIDED: RMM core first (spec 29 → 30).**
- Retention/scale: metric history on ~hundreds of devices — sampling cadence +
  retention window (ties into whether SQL push-down from spec 26 is needed).
- Agentless vs. agent: richer real-time monitoring may eventually want a light agent;
  today's collector is agentless (WinRM/SNMP). Worth an explicit decision at spec 29.
