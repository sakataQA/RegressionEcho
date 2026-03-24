---
name: csv-tsv-to-drawio-xml-flow-generator
description: Convert a human-authored CSV or TSV test flow into a draw.io compatible XML flow for downstream Playwright test generation. Use when Codex is asked to read a spreadsheet-like test case table, validate the rows, normalize step semantics, and emit a deterministic XML flow artifact that preserves step order, data capture, comparisons, branches, and manual-check markers.
---

# CSV/TSV to draw.io XML Flow Generator

## Purpose

Convert a human-authored CSV or TSV test case definition into a draw.io / diagrams.net XML file that is safe for downstream automation.

The generated XML is **not** just a visual diagram. It is the canonical machine-readable flow contract used by the next skill.

## Output Contract

Always return these deliverables:

1. the generated draw.io XML
2. a normalized step table used to produce the XML
3. a validation summary with warnings for ambiguous rows
4. a short mapping memo that lists which CSV/TSV columns were mapped to which XML fields

If requested, also return a sidecar JSON document that contains the normalized steps.

## Input Expectations

Expect a CSV or TSV with human-authored rows such as:

- step number
- intent / why the check matters
- action description
- start URL
- destination URL
- procedure
- expected result

Column names may vary. Detect likely equivalents before parsing. Common variants include:

- `No`, `No.`, `Step`, `step_no`
- `確認したいことの意図`, `intent`, `purpose`
- `やること`, `action`, `summary`
- `開始URL`, `start_url`
- `遷移先URL`, `end_url`, `destination_url`
- `操作手順`, `procedure`, `steps`
- `期待値`, `expected`, `assertion`
- `ケース名`, `case_name`

Treat blank rows, decorative rows, and footer rows as non-steps unless they clearly contain a numbered scenario step.

## Workflow

Follow this workflow in order.

### 1. Read and Normalize the Table

- Detect delimiter from the uploaded file or content.
- Read the header row first.
- Normalize column names to canonical internal fields.
- Preserve original row numbers for traceability.
- Ignore fully blank rows.
- Ignore rows that do not represent scenario steps unless they carry metadata like case name.
- Preserve the original step order exactly.

### 2. Infer the Canonical Step Model

For each scenario row, build a normalized internal step object with these fields when available:

- `stepNo`
- `title`
- `intent`
- `type`
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
- `notes`

### 3. Classify Each Step Type

Classify every step into one of these types:

- `start`
- `navigate`
- `action`
- `observe`
- `capture`
- `assert`
- `count`
- `branch`
- `export`
- `end`

Use these heuristics:

- If the row says to tap, click, press, swipe, or open something, prefer `action`.
- If the row focuses on route change or screen movement, prefer `navigate`.
- If the row says to note a value, print to stdout, memo a number, or keep a value for later comparison, prefer `capture`.
- If the row says to confirm, verify, ensure, compare, or check an outcome, prefer `assert`.
- If the row says to count types, frequencies, or occurrences, prefer `count`.
- If the row says to export to CSV or prepare something for later visual confirmation, prefer `export` and mark it as manual if no automated assertion is described.
- If the row is just context for where the scenario begins or ends, map to `start` or `end`.

Never leave a step untyped. If uncertain, choose the best-fit type and emit a warning.

### 4. Extract Structured Testing Semantics

Derive structure from natural language where possible.

#### Data capture

When a row indicates saving a value for later use, populate:

- `type = capture`
- `saveAs` with a stable snake_case or camelCase variable name
- `target` with the business value being captured

Examples:

- `数字を控える（stdout） ※所持枚数(開封前)` -> `saveAs = collectionCountBefore`
- `数字をメモる（stdout） ※開封前のバモス数` -> `saveAs = vamosBefore`

#### Comparisons

When a row compares with an earlier step, populate:

- `type = assert`
- `compareWith` with a prior variable name if recoverable
- `operator` with one of:
  - `equals`
  - `not_equals`
  - `greater_than`
  - `greater_than_or_equals`
  - `less_than`
  - `less_than_or_equals`
  - `delta_equals`
  - `count_less_than_or_equals`
  - `contains_all`
  - `matches_sequence`
- `expectedValue` when a numeric or text delta is stated

Examples:

- `50減っていること` -> `operator = delta_equals`, `expectedValue = -50`
- `10枚増えていること` -> `operator = delta_equals`, `expectedValue = 10`
- `No.3 の数値と比較する` -> `compareWith = collectionCountBefore`

#### Manual review

If the row explicitly requires later visual checking or cannot be deterministically automated from the row alone:

- set `manual = true`
- keep the original text in `notes`

### 5. Build the XML Graph

Generate a draw.io compatible XML with these requirements:

- Use a single main linear path unless the source explicitly implies a branch.
- Preserve step numbering in node metadata and visible labels.
- Use one node per step.
- Connect nodes in the original row order.
- Add side nodes only for explicit non-linear actions such as export-for-later-review.

### 6. Encode Rich Metadata in Each Node

Use `object` elements when possible so structured attributes are preserved, with an inner `mxCell` child.

Each scenario node should include attributes like:

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
- `caseName`

The visible label should stay readable for humans. Use a compact multi-line label like:

`No.15\n50減っているか確認する\ncompareWith=vamosBefore delta=-50`

The structured attributes are the source of truth for downstream skills. The visible label is only for review.

### 7. Validate Before Returning

Validate all of the following:

- step numbers are unique and ordered
- every non-start/non-end step has a type
- every `capture` step has `saveAs`
- every comparison step has `compareWith` or a warning
- every node is connected in the expected order
- destination URLs, if present, are preserved
- manual-only checks are marked with `manual = true`

If anything is ambiguous, still produce XML, but include a warning block.

## XML Shape Guidelines

Use this pattern for step nodes when possible:

```xml
<object label="No.8&#xa;数字をメモる（stdout）&#xa;saveAs=vamosBefore"
        stepNo="8"
        type="capture"
        title="数字をメモる（stdout）"
        target="開封前のバモス数"
        saveAs="vamosBefore"
        manual="false">
  <mxCell vertex="1" parent="1" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#1a1a1a;">
    <mxGeometry x="300" y="760" width="360" height="70" as="geometry" />
  </mxCell>
</object>
```

For edges, preserve draw.io compatibility with standard `mxCell edge="1"` elements.

## Mapping Rules

### Recommended column-to-field mapping

Map the source columns into XML metadata like this:

- `No` -> `stepNo`
- `確認したいことの意図` -> `intent`
- `やること` -> `title` or `action`
- `開始URL` -> `startUrl`
- `遷移先URL` -> `destinationUrl`
- `操作手順` -> `procedure`
- `期待値` -> `expected`

### Heuristic enrichment rules

- If `やること` is short and `操作手順` is fuller, use `やること` as `title` and `操作手順` as `procedure`.
- If `期待値` expresses the real assertion and `やること` is only operational, set `type = assert` and preserve both.
- If `操作手順` says to print or memo a value, prefer `capture` even if `やること` is vague.
- If the row references `No.X`, resolve it to the saved variable of that earlier step whenever possible.

## Warning Policy

Emit warnings for any of these cases:

- missing step number
- duplicate step number
- comparison references a step that has no known capture variable
- assertion text is too vague to infer an operator
- action row mixes multiple independent actions that should probably be split
- start and destination URLs conflict with the described route
- a manual visual check is present without being flagged

Warnings should be concise and actionable.

## Guardrails

- Do not silently drop numbered rows.
- Do not reorder steps.
- Do not compress multiple numbered rows into one node.
- Do not replace human-written intent with a shorter paraphrase if nuance would be lost.
- Do not invent branches unless the source implies them.
- Do not force every row into a fully automated assertion; manual review is allowed and should be marked explicitly.
- Do not output raw prose only; always emit real draw.io compatible XML.

## Notes for Downstream Compatibility

The downstream Playwright skill expects structured metadata in the XML, especially:

- `stepNo`
- `type`
- `saveAs`
- `compareWith`
- `operator`
- `expectedValue`
- `manual`

If these are absent, downstream automation becomes more heuristic and less stable.

Optimize for deterministic downstream parsing, not just visual prettiness.
