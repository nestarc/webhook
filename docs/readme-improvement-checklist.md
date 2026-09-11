# README audit improvement checklist

Baseline: `@nestarc/webhook` 0.13.1, commit `60b2725`. Scope fixed on 2026-09-11 from the README audit and approved improvement request.

This file tracks implementation and verification. It is not the package usage contract; use [usage.md](./usage.md), the [README](../README.md), and the installed package's types. Source fixes are unreleased until a new package version is published.

## Fixed scope

- [x] F01 — Replace duplicate-delivery guarantees with atomic claim semantics, bounded retries, receiver deduplication, and business-transaction boundaries.
- [x] F02 — Explain enqueue-time signing snapshots and rotation expiry, and correct secret-return behavior.
- [x] F03 — Persist `correlationId` independently of `idempotencyKey` across publish APIs; regression-test storage.
- [x] F04 — Make replay inherit configured delivery attempt limits; regression-test the public service and database.
- [x] F05 — Remove ineffective built-in retry/replay `reason` examples and document custom-adapter metadata support explicitly.
- [x] F06 — Distinguish timestamp freshness from duplicate-request detection; demonstrate receiver verification and deduplication.
- [x] F07 — Qualify audit completeness and response truncation; correct the HTTP transport and redirect explanation.
- [x] F08 — Document circuit-breaker effects on new and already-queued deliveries.
- [x] F09 — State the precise Standard Webhooks signing/header compatibility and legacy secret format constraints.
- [x] U01 — Put endpoint registration before publishing and provide observable first-delivery success.
- [x] U02 — Complete Node/Prisma prerequisites, exact installs, CommonJS generation, environment, and shutdown instructions.
- [x] U03 — Document tenant targeting, signatures, return values, errors, replay scope, and payload-purge interactions; prevent retrying purged payloads.
- [x] U04 — Explain total attempts, the default four retry delays, jitter, and the optional 24-hour stage.
- [x] U05 — Give explicit ordered v0.9.0/v0.12.0/v0.13.0 upgrade instructions.
- [x] U06 — Improve README navigation and separate setup, retry policy, retention, and operational details without redundant claims.
- [x] D01 — Improve npm description/keywords/homepage and GitHub topics/homepage using factual package characteristics.
- [x] D02 — Link official documentation/API/npm and include referenced consumer documents in the packed artifact.
- [x] A01 — Provide a version-aware consumer guide with authoritative API contracts and adapter capability notes.
- [x] A02 — Add an executable packed-package consumer example and a real PostgreSQL/HTTP CI verification path.
- [x] A03 — Label historical design documents so agents do not mistake them for current usage instructions.
- [x] A04 — Add webhook entries to the official documentation's AI index and synchronize relevant website usage documentation.
- [x] V01 — Verify lint/build, unit and PostgreSQL tests, consumer installation, documentation links/pack contents, and website checks; record limitations honestly.

## Implementation decisions

- Preserve endpoint snapshot behavior and public legacy secret acceptance; clarify guarantees rather than introduce a breaking rotation or secret-format change.
- Preserve the `reason` option for custom repositories. The built-in adapter does not persist administrative reasons; no new audit schema is introduced by this documentation correction.
- Fix silent metadata loss, replay configuration, and unsafe retries after payload purging in code with regression coverage.
- Website source improvements and GitHub discovery metadata are in scope. Package publication and website deployment are separate release operations and are not implied by passing local checks.

## Verification evidence

- Type checking and build passed.
- All 310 unit tests passed, including local HTTP transport tests.
- All 29 Prisma 7.10.0/PostgreSQL E2E cases passed, including six controlled retry/replay/retention races and three correlation-only publish paths.
- The strict modern packed consumer passed; public types, CommonJS loading, dependency integrity, and required packaged documentation were verified.
- The executable packed quick-start consumer passed with real scheduled delivery, SENT/attempt assertions, tampered-body rejection, duplicate acknowledgement without a second business effect, and isolated-schema cleanup.
- Local links and anchors in current Markdown guides passed; git diff whitespace checks passed. Historical records were labelled.
- GitHub repository description, official-documentation homepage, and seven topics were updated and read back successfully.
- Independent source review found one incorrect new deletion-contract statement; it was corrected to the schema's foreign-key behavior. No additional concrete regression was found in the reviewed code.
- Official-site documentation synchronization passed `docs:check`: 78/78 tests, VitePress build, and 192 public pages/193 HTML files validated. Existing unrelated site changes were preserved; generated released API documentation was not regenerated from unreleased code.
- The exact NestJS 10.4.20 / schedule 4.1.2 / Prisma 6.19.3 tuple passed all 29 PostgreSQL E2E cases on Node 24.11.1 in an isolated copy, which was removed afterward. Root dependencies and lockfile were preserved.
- Official site source changes cover 19 files, including `packages/webhook/agent-guide.md`, Korean webhook pages, AI index, navigation, and route validation. No package publication, website deployment, commit, or push was performed.
