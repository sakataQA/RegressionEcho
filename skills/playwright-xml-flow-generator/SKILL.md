---
name: playwright-xml-flow-generator
description: Generate Playwright TypeScript end-to-end tests from a draw.io XML flow by extracting ordered steps, inspecting the live application with Playwright MCP, collecting stable selectors, and writing specs that match this repository's helper-first conventions. Use when Codex is asked to read a draw.io or diagrams.net XML flow, understand the scenario it describes, inspect the real UI, and create or update Playwright tests for this repo.
---

# Playwright XML Flow Generator

# Workflow

Follow this workflow in order. Do not skip live inspection: selector guesses are not acceptable for this skill.

## 1. Read the Flow Artifact

- Open the provided XML file and extract the ordered user actions, assertions, branches, and data capture points.
- Treat the XML as the source of truth for flow order.
- If the diagram contains IDs only, recover labels from sibling `mxCell`, `object`, or edge metadata before interpreting the step.
- Build a numbered step list first. Keep the original numbering in the final Playwright `test.step()` titles.
- If the XML implies a branch or optional dialog, mark it explicitly so the generated test can handle it safely.

## 2. Load Only the Relevant Repo Context

- Read the spec or helper files the user mentions.
- If the user does not point to examples, read the repo conventions reference at [references/repo-conventions.md](./references/repo-conventions.md).
- In this repository, prefer reusing helpers in `tests/flow-helpers.ts` instead of embedding fragile page logic in each spec.
- Check `playwright.config.js` and `playwright.global-setup.js` only when auth, `storageState`, base URL, or global setup behavior affects the scenario.

## 3. Inspect the Live App with Playwright MCP

- Use Playwright MCP before writing selectors.
- Use these tools directly when relevant:
  - `mcp__playwright__browser_navigate`
  - `mcp__playwright__browser_snapshot`
  - `mcp__playwright__browser_click`
  - `mcp__playwright__browser_wait_for`
  - `mcp__playwright__browser_evaluate`
- Navigate through the real flow and capture locator candidates for each actionable step.
- Record route changes, modal behavior, loading states, optional dialogs, and any scrolling/swiping required.
- If the first locator is brittle, collect a fallback candidate while inspecting.

## 4. Choose Locator Strategy

Prefer locators in this order:

1. `data-testid`
2. `getByRole(...)`
3. `getByLabel(...)`
4. `getByText(...)`
5. stable CSS or DOM fallback only when necessary

When elements are dynamic:

- Prefer helper functions that try multiple selectors in order.
- Guard optional dialogs and animations.
- Add waits for route changes with `waitForURL(...)` or repo-consistent `expect(page).toHaveURL(...)`.
- Use scrolling or swipe helpers when the XML implies off-screen controls.

## 5. Generate the Test

- Write the scenario as a Playwright TypeScript spec in `tests/`.
- Convert every XML step into one `test.step()`.
- Include the original step number in each step title.
- Preserve flow order exactly as written in the XML.
- Reuse or extend `tests/flow-helpers.ts` when repeated interaction logic appears.
- Do not hardcode credentials. Reuse existing auth helpers, `storageState`, fixtures, and environment assumptions already present in the repo.
- Keep assertions explicit for the checks described in the XML.
- If the flow needs new helpers, add them in the same style as the existing helper file: defensive selector handling, small focused functions, and route-aware waits.

## 6. Return the Deliverables

Return:

1. the new spec file
2. helper additions or helper changes
3. locator definitions if needed
4. a short implementation memo listing what Playwright MCP inspected

## Guardrails

- Do not invent selectors without inspection.
- Do not collapse multiple XML steps into one `test.step()`.
- Do not reorder the flow for convenience.
- Do not introduce login code if repo auth setup already covers the scenario.
- Do not add generic helper abstractions unless at least one existing pattern in the repo supports them.

## Notes for This Repository

- Existing specs in `tests/` already use numbered `test.step()` blocks and helper-driven flows.
- Existing helper code handles retries, dialogs, URL stabilization, and mixed selector fallback patterns. Match that style instead of generating minimal demo-style Playwright code.
- When the XML references swipes, scrolling, dialogs, or payment/auth flows, inspect whether a helper already exists before adding a new one.
