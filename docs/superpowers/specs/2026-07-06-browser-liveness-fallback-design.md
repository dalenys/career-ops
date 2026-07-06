# Browser Liveness Fallback Design

## Problem

Career-ops scan mode currently treats the interactive browser tools as the only
acceptable way to verify search-engine-only job leads. In Codex sessions where
the in-app browser backend is not registered, this causes the agent to leave
potential leads unverified even though the repository already ships a working
Playwright-based liveness checker.

The behavior is caused by instruction drift:

- `CLAUDE.md` and `modes/pipeline.md` already direct agents to
  `check-liveness.mjs`.
- `AGENTS.md` and `modes/scan.md` still require direct
  `browser_navigate`/`browser_snapshot` calls.
- `doctor.mjs` warns when Playwright MCP is absent without distinguishing
  interactive extraction from repo-local liveness verification.

## Goal

Ensure scan mode can verify search-engine-only leads when interactive browser
tools are unavailable, without weakening the rule against trusting search
snippets as liveness evidence.

## Design

Use the existing `check-liveness.mjs` command as the standard liveness gate:

1. Run `node check-liveness.mjs <url>` for each search-engine-only lead.
2. Accept `active` results from either the ATS API rung or the script's local
   Playwright rung.
3. Discard only definitive `expired` results.
4. Keep `uncertain` results out of the pipeline until they can be confirmed;
   never rewrite uncertainty as expiration.
5. Use direct interactive browser tools when they are available and JD content
   must be inspected, but do not require them solely for liveness.

No new verification script or dependency will be introduced.

## Changes

- Align `AGENTS.md` offer-verification rules with the existing API-first,
  local-Playwright fallback documented in `CLAUDE.md`.
- Update `modes/scan.md` Level 3 verification to call
  `check-liveness.mjs` when direct browser tools are unavailable.
- Clarify the `doctor.mjs` warning: Playwright MCP is required for interactive
  browser extraction, while `check-liveness.mjs` remains available for
  liveness checks.
- Extend `test-all.mjs` with regression assertions covering the fallback and
  uncertainty handling.

## Error Handling

- An `active` verdict permits the lead to enter `data/pipeline.md`.
- An `expired` verdict records `skipped_expired`.
- An `uncertain` verdict or checker failure does not enter the pipeline and is
  reported for later confirmation.
- Sandbox-denied browser launches should be retried with explicit approval for
  the narrowly scoped `node check-liveness.mjs` command.

## Verification

- Run the new regression assertions and confirm they fail before the
  documentation changes.
- Run `node test-all.mjs`.
- Run `node doctor.mjs --json` and confirm its warning accurately describes the
  remaining limitation.
- Run `node check-liveness.mjs` against one ATS-hosted lead and one lead that
  requires local Chromium, confirming both verification rungs work.

## Non-Goals

- Installing or registering a Playwright MCP server.
- Restoring a Codex in-app browser target from repository code.
- Replacing the existing liveness classifier.
- Automatically adding every search result without verification.
