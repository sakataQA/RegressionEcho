---
name: playwright-xml-flow-generator
description: Generate Playwright TypeScript end-to-end tests from a structured draw.io XML flow by extracting ordered typed steps, inspecting the live application with Playwright MCP, collecting stable selectors, and writing specs that match this repository's helper-first conventions. Use when Codex is asked to read a draw.io or diagrams.net XML flow that contains step metadata such as type, saveAs, compareWith, operator, and manual flags, then create or update Playwright tests for this repo.
---

# Playwright XML Flow Generator

## Purpose

Read a structured draw.io XML flow and turn it into repository-quality Playwright TypeScript tests.

This skill assumes the XML may contain rich metadata produced by an upstream CSV/TSV-to-XML skill. Prefer structured attributes over label text whenever both are present.

## Workflow

Follow this workflow in order. Do not skip live inspection. Selector guesses are not acceptable.

## 1. Read and Normalize the XML Flow

- Open the provided XML file.
- Extract steps from `object`, `mxCell`, edge metadata, and visible labels.
- Prefer structured attributes first:
  - `stepNo`
  - `type`
  - `title`
  - `intent`
  - `action`
  - `target`
  - `startUrl`
  - `destinationUrl`
  - `procedure`
  - `expected`
  - `saveAs`
  - `compareWith`
  - `operator`
  - `expectedValue`
  - `manual`
  - `branchLabel`
- Use label text only as a fallback when structured attributes are missing.
- Reconstruct the ordered main path from the directed edges.
- Detect side branches and mark them as either:
  - optional flow
  - export/manual-review side path
  - unsupported branch that needs explicit handling
- Build a normalized numbered step list before generating code.
- Keep the original numbering in final `test.step()` titles.

## 2. Convert XML Steps into an Automation Plan

Map each normalized step to one of these execution categories:

- `navigate`
- `action`
- `capture`
- `assert`
- `count`
- `export`
- `manual`

Then create an automation plan that includes:

- UI action to perform
- UI element to inspect with MCP (do NOT finalize selectors here; this is an inspection plan, not a selector decision)
- value to capture
- assertion style
- helper reuse candidate
- wait strategy
- fallback strategy for brittle or dynamic UI

### Type handling rules

#### `navigate`

- Prefer URL-based assertions when `destinationUrl` is provided.
- Use repo-consistent `expect(page).toHaveURL(...)` or helper-based route waits.

#### `action`

- Model taps, clicks, swipes, opens, and closes.
- If the XML implies a swipe or scroll, inspect whether a helper already exists before writing inline logic.

#### `capture`

- Capture visible values into local variables keyed by `saveAs`.
- Use typed variable names in the spec.
- Record the exact DOM source inspected during Playwright MCP exploration.

#### `assert`

- Prefer structured comparisons when `compareWith`, `operator`, and `expectedValue` are present.
- Examples:
  - `delta_equals -50`
  - `delta_equals 10`
  - `matches_sequence`
  - `count_less_than_or_equals`
- If metadata is missing, fall back to explicit assertion text from `expected`.

#### `count`

- Treat counting as a first-class action, not as vague prose.
- Name the collected counts clearly.
- Assert upper bounds or equality based on structured metadata or the step text.

#### `export`

- Do not force an automated assertion if the XML marks the step as `manual=true`.
- Generate implementation that produces the artifact and log a comment that downstream human review is expected.

#### `manual`

- Keep the step in `test.step()`.
- If the repo style allows, annotate clearly with `test.info().annotations.push(...)` or a concise code comment.
- Never silently omit manual checks from the flow.

## 3. Load Only the Relevant Repo Context

- Read the spec or helper files the user mentions.
- If the user does not point to examples, read the repo conventions reference at `references/repo-conventions.md`.
- Prefer reusing helpers in `tests/flow-helpers.ts` instead of embedding fragile page logic in each spec.
- Check `playwright.config.js` and `playwright.global-setup.js` only when auth, `storageState`, base URL, or global setup behavior affects the scenario.
- Before adding a new helper, verify whether an existing helper already covers:
  - route stabilization
  - modal handling
  - retries
  - swipes or scrolling
  - mixed selector fallback
  - value extraction and parsing

## 4. Inspect the Live App with Playwright MCP

Use Playwright MCP before writing selectors or helper code.

The `target` attribute from upstream XML describes the business value (e.g., "開封前のバモス数"), NOT a DOM selector. Always derive actual selectors from live MCP inspection.

Use these tools directly when relevant:

- `mcp__playwright__browser_navigate`
- `mcp__playwright__browser_snapshot`
- `mcp__playwright__browser_click`
- `mcp__playwright__browser_wait_for`
- `mcp__playwright__browser_evaluate`

During inspection, collect all of the following:

- stable locator candidates for every actionable step
- route changes
- modal and dialog behavior
- loading and animation states
- whether off-screen controls require scroll or swipe
- where captured values come from in the DOM
- whether expected text changes by locale or runtime data

Record both the preferred locator and one fallback when the UI is dynamic.

## 5. Choose Locator Strategy

Prefer locators in this order:

1. `data-testid`
2. `getByRole(...)`
3. `getByLabel(...)`
4. `getByText(...)`
5. stable CSS or DOM fallback only when necessary

Additional rules:

- Use a helper-level fallback sequence when a step is known to be dynamic.
- Prefer container-scoped locators when repeated text exists.
- For values used in `capture`, choose locators that are stable enough for parsing, not just clicking.
- Guard optional dialogs explicitly.
- Add waits for route changes, async content, and animation completion.
- Avoid arbitrary fixed waits unless the repo already uses them as a last resort.

## 6. Generate the Test

- Write the scenario as a Playwright TypeScript spec in `tests/`.
- Convert every XML step into one `test.step()`.
- Include the original step number in each title.
- Preserve flow order exactly as written in the XML.
- Reuse or extend `tests/flow-helpers.ts` when repeated interaction logic appears.
- Do not hardcode credentials. Reuse existing auth helpers, `storageState`, fixtures, and environment assumptions already present in the repo.
- Keep assertions explicit and aligned to the XML metadata.
- When values are captured for later comparison, keep them in clearly named variables matching `saveAs` where reasonable.
- When the flow includes manual review steps, keep them visible in the generated spec rather than deleting them.

### Comparison generation rules

When the XML provides comparison metadata, generate assertions from it directly.

Examples:

- `operator = delta_equals`, `compareWith = vamosBefore`, `expectedValue = -50`
  - generate a post-action capture and `expect(after - vamosBefore).toBe(-50)` or a repo-consistent equivalent
- `operator = delta_equals`, `compareWith = collectionCountBefore`, `expectedValue = 10`
  - generate `expect(after - collectionCountBefore).toBe(10)`
- `operator = matches_sequence`
  - compare actual displayed sequence to the previously captured sequence
- `operator = count_less_than_or_equals`
  - count and assert upper bound clearly

### Manual-step generation rules

If `manual=true`:

- keep the step as a `test.step()`
- add a concise comment or annotation stating why the step remains manual
- if the step still has an automatable subpart, automate that subpart and leave the human-only portion clearly marked

## 7. Return the Deliverables

Return:

1. the new or updated spec file
2. helper additions or helper changes
3. locator definitions or selector notes if needed
4. a short implementation memo listing what Playwright MCP inspected
5. any XML issues discovered that should be fixed upstream

## Guardrails

- Do not invent selectors without inspection.
- Do not collapse multiple XML steps into one `test.step()`.
- Do not reorder the flow for convenience.
- Do not discard `manual=true` steps.
- Do not ignore structured XML attributes in favor of looser label text.
- Do not introduce login code if repo auth setup already covers the scenario.
- Do not add generic helper abstractions unless an existing repo pattern supports them.
- Do not silently reinterpret `compareWith` references; if they are unresolved, report the issue.
- Do not treat XML `target` or `action` attributes as selector hints. They are business descriptions. Selectors come only from Playwright MCP inspection.

## Optimization Notes for This Repository

- Existing specs in `tests/` already use numbered `test.step()` blocks and helper-driven flows.
- Existing helper code handles retries, dialogs, URL stabilization, and mixed selector fallback patterns. Match that style instead of generating minimal demo-style Playwright code.
- When the XML references swipes, scrolling, dialogs, or result-list verification, inspect whether a helper already exists before adding a new one.
- Prefer an explicit variable-based data flow in the spec when the XML contains `saveAs` and `compareWith`; that makes later review and debugging much easier.
- If the XML came from the upstream CSV/TSV skill, treat its structured attributes as the automation contract and its label text as reviewer-friendly display only.
