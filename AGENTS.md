# Repository guidance

## Scope

This repository owns the native desktop application and its integration adapters. AgentSpaces remains the upstream coordination framework. Preserve its participant, identity, admission, work, lease, result, and artifact contracts rather than creating a parallel registry or scheduler.

The current repository contains a product foundation only. Read README.md before implementation. A proposed component is not an implemented feature; passing fixtures are not live integration or release qualification.

## Changes

- Verify the current remote default branch before selecting a base or publishing changes.
- Inspect local changes and preserve work owned by other sessions. Use a unique owned branch and worktree for implementation.
- Keep provider-specific behavior inside adapters and qualify supported versions explicitly.
- Prefer stable, documented integration interfaces. Do not patch native conversation files or rely on private provider endpoints.
- Obtain explicit authority before connecting accounts, enrolling existing private histories, resuming native sessions, spending on model calls, scheduling maintenance, making the repository public, or publishing a release.
- Never commit credentials, session tokens, private conversation logs, account exports, or machine-specific configuration.
- Do not alter another product or deployment as an implicit part of this application's work.

## Verification

Exercise permissions, provenance, busy-thread exclusion, cancellation, duplicate delivery, usage accounting, and restart recovery when their implementation is introduced. Fixture tests should be the default; live tests must declare their credentials, allowed actions, and budget without exposing secret values.

For each implementation handoff, report the repository, verified remote default head, base, branch, head, changed files, tests, runtime evidence, remaining blockers, and explicit nonclaims. Preserve the distinction between implemented, tested, demonstrated, and released.

## Publication

Keep upstream attribution and required license notices. The application is licensed under Apache 2.0. Preserve LICENSE and NOTICE plus dependency notices; review redistribution terms and platform qualification before publishing binaries. Use normal reviewed changes; do not force-push or rewrite shared history.
