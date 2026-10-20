# 34. AI-assisted IT operations — rationale

## Why optional / modular?

H2Tecs is on-prem and must work offline from any LLM vendor. AI is acceleration
for techs, not a dependency for inventory, scan, deploy, or scripts. A `noop`
provider keeps that contract honest.

## Why a web gateway, not the collector?

Assist is read-mostly over data **web already owns**. The collector is for
outbound WinRM/SNMP. Putting LLM I/O in web avoids a fourth long-lived process
and keeps API keys off the scan worker.

## Why OpenAI-compatible free cloud first?

One HTTP shape covers Groq, OpenRouter free models, and later private gateways.
Techs can try Assist without buying a dedicated GPU box; production sites can
point `AI_BASE_URL` at an internal endpoint without rewriting the app.

## Why not a new `ai:assist` permission in v1?

Summaries are an alternate view of `asset:read` data. Draft/run already sits
behind `software:deploy`. A third permission can wait until Assist is used
outside computer detail or by a wider audience.

## Why drafts never auto-run?

LLM output is untrusted code. Spec 32 already has freeze-at-enqueue, audit, and
one-in-flight guards — Assist should **feed** that path, not bypass it.

## Why facts vs hypotheses in the schema?

Techs will treat fluent prose as ground truth. Forcing separate arrays in the
response (and UI) makes the product honest even when the model is wrong.

## Why hash the context pack instead of storing prompts?

On-prem customers will ask what left the building. A hash + action metadata is
enough to audit “who asked what kind of assist when” without retaining
potentially sensitive redacted packs by default.
