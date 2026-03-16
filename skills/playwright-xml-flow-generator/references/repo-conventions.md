# Repo Conventions

Load this file when the user does not already point you to the exact reference specs or helpers.

## Files to Inspect First

- `tests/flow-helpers.ts`: shared navigation, dialog handling, selector fallback, and data capture helpers.
- `tests/login-relogin-nickname.spec.ts`: clean example of numbered `test.step()` blocks and helper-first flow composition.
- `tests/pack-open.spec.ts`: scrolling, repeated route checks, stdout capture, and animation handling.
- `tests/purchase.spec.ts`: modal-heavy flow, fallback selectors, and payment-specific waits.
- `playwright.config.js`: base URL, `storageState`, reporter, and worker model.
- `playwright.global-setup.js`: global auth bootstrap and saved session behavior.

## Style Rules Observed in This Repo

- Write specs in TypeScript under `tests/`.
- Use `import { test, expect } from '@playwright/test';`.
- Prefer extracting interaction logic into `tests/flow-helpers.ts` instead of embedding long locator sequences in the spec.
- Use numbered Japanese step titles where the source flow is already numbered; preserve the source numbering rather than renumbering semantically.
- Assert route transitions with `expect(page).toHaveURL(...)` and helper-driven navigation.
- Handle optional dialogs and inconsistent UI with layered selector attempts and small waits.
- Keep tests single-worker friendly and tolerant of slow rendering.

## Locator Patterns Already Used

- Role and text-based Playwright locators for visible controls.
- CSS fallback selectors for framework-generated markup and dialog internals.
- DOM evaluation when the UI is hard to model with pure locators.

Prefer improving an existing helper over creating a one-off selector chain inside a spec.
