# OPUS — IT Inventory Documentation

**OPUS** is an on-premise, enterprise-grade IT asset management system for computers,
monitors, printers, phones and related IT items — built to maintain 100+ machines.
(Repo/working dir: `aw-inventory`.)

## Start here
- **[specs/00-overview-and-plan.md](specs/00-overview-and-plan.md)** — vision, architecture
  at a glance, phased roadmap, risks, definition of done.

## Specs
| Doc | Topic |
|---|---|
| [specs/01-system-architecture.md](specs/01-system-architecture.md) | Services, topology, data flow, on-prem deployment, security posture |
| [specs/02-auth-service-spec.md](specs/02-auth-service-spec.md) | `aw-auth` — standalone Django IdP: RBAC, MFA, tokens, service accounts, portability |
| [specs/03-inventory-data-model.md](specs/03-inventory-data-model.md) | Assets, lifecycle, people, locations, warranty, scan tables, reconciliation |
| [specs/04-collector-agent-spec.md](specs/04-collector-agent-spec.md) | Python agentless collector — discovery, credential vault, WinRM/WMI/SNMP, ingest |
| [specs/05-frontend-spec.md](specs/05-frontend-spec.md) | Next.js app — routes, registry screen, components, data + auth wiring |

## Design
| Doc | Topic |
|---|---|
| [Design/design-system.md](Design/design-system.md) | OPUS visual language — dark-first enterprise dashboard, teal accent, tokens, components |
| [Design/opus-dashboard.html](Design/opus-dashboard.html) | Interactive dashboard mockup (also published as an Artifact) |
| [Design/mock2.jpg](Design/mock2.jpg) | Chosen reference mock (direction) |
| [Design/mock.png](Design/mock.png) | Earlier reference mock (superseded) |

## Locked decisions (2026-08-21)
- **Name:** **OPUS** (IT Inventory).
- **Design direction:** modern **dark-first enterprise dashboard**, teal accent, per
  `Design/mock2.jpg` — sidebar + top bar, KPI cards, asset table, charts.
- **Hosting:** self-hosted / on-prem (Docker), data stays on the network.
- **Auth:** standalone, portable **Django + DRF** identity provider (`aw-auth`).
- **Frontend + inventory API:** Next.js (App Router) + Tailwind v4 + shadcn/ui.
- **Scanning:** agentless Python collector over WinRM/WMI/SMB + SNMP for printers.
- **Fleet:** all Windows; domain on `192.168.70.0/24` (incl. printers), workgroup on
  `192.168.72.0/24`; ~3 local-admin credential profiles resolved by rules + fallback.
