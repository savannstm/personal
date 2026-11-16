# Fix Tests

Apply the findings of a review-tests report. Division of labor: the review-tests step judges (blind, report only); this step executes. Do not re-review the suite or hunt for new defects here; work from the report. You are prohibited from spawning your own subagents.

## Input

The review-tests report (its final message, or the report file whose path it returned), plus its ledger if available. If you are given neither, stop and say so; do not review the suite yourself. Default scope: all `certain` and `probable` findings; leave `needs-source`/unconfirmed ones alone unless the user approved them. If the user approved a subset, do only that.

Treat the report as a list of claims to verify, not as truth: the reviewer judged without running anything, and each finding is confirmed empirically below before it is applied.

## Completeness

Each finding in scope ends as `applied`, `refuted` or `skipped (reason)`. Work through them one by one and account for every one in the final report; do not stop at the easy ones and do not leave any finding without a status. If context compacts, per-finding patch files and your running status list are the record to resume from.

Before the final report, re-check the status list: any A/B/D finding without the mutation evidence Step 1 requires goes back to Step 1. Do not hand the job back to the user for another iteration.

Why strict: a "duplicate" may guard a branch nobody noticed, and changing tests on an unverified opinion silently removes protection while the suite stays green. So every finding is **confirmed empirically** and every change is **bracketed by test runs**, even findings marked certain.

Respect project rules about building and running (some repos forbid full builds); if the suite cannot be run here, stop and tell the user rather than applying fixes unverified.

## Step 0: Safety and baseline
1. Confirm the test files you will edit have no uncommitted user changes; if they do, ask before touching them. Never commit unless asked.
2. Work in a scratch copy of the repo outside the tree (e.g. `git worktree add` to a temp dir, or `cp -r`) for every experiment that touches **source code** (mutations below). Source files in the real tree are never modified in this phase, not even temporarily. Only test files in the real tree change.
3. Run the full suite **before any change**, following the run protocol (`~/.claude/skills/test-pipeline/SKILL.md`), including its offscreen-display rule: window-drawing tests run under `xvfb-run -a` with `WAYLAND_DISPLAY` unset, never on the user's desktop. Record: command used, per-test result (id -> pass/fail/skip), totals, durations, and warnings. If the framework supports it, also record line and branch coverage (overall and per file). Run it twice; any test whose result differs is flaky - exclude it from comparisons and list it.
4. If the baseline is red, do not fix on top of red. Record the failing tests as pre-existing, exclude them from before/after comparison, and tell the user. If red tests are in the findings' scope, skip those findings.

## Step 1: Confirm the finding (per finding, before editing)
Use every method that applies. Mutation is mandatory wherever possible: a finding in category A, B or D is confirmed only with mutation runs, recording a mutant's result on the old test and on the new one. Non-mutation checks (coverage, case lists, REPL echo checks) are added on top, never instead. A mutation is "possible" when some source code the test exercises can be perturbed in the scratch copy; find that code first and mutate it. Only when no such code exists (e.g. the test only exercises a pure framework feature) may you skip mutation, and then you must write the reason in the finding's evidence. "Mutation not run" with no reason is not a valid status. If any method contradicts the finding, mark it **refuted**, do not apply it, and report it as an evaluation error - that is a valid, useful outcome.

- **A. Duplicate:** (1) Run the candidate for deletion alone with coverage, and the keeper alone with coverage; the candidate's covered lines and branches must be a subset of the keeper's. (2) In the scratch copy, apply the plausible mutations to code both tests touch (or run the project's mutation tool scoped to those files: mutmut, cargo-mutants, Stryker, pitest, etc.); every mutant the candidate kills must also be killed by the keeper. (3) Diff assertions side by side once more.
- **B. Vacuous / tautological:** In the scratch copy, inject the specific bug named in the finding's evidence. The test must still pass (confirms vacuous). After rewriting it, the same mutant must make it fail, and the unmutated code must make it pass. If the rewritten test fails on unmutated code, you found either a real bug or a wrong oracle - do not "fix" source and do not leave the suite red: park the rewrite as a patch file, keep the original test, and report it prominently.
- **C. Fragmented:** Before editing, list the case tuples (inputs, expected, test id) of all fragments. After parametrizing, the multiset of cases must be identical 1:1 - none lost, none duplicated, each executed (check the runner reports N cases). Where a fragment had a distinct purpose you declared in Phase 1, confirm it survives as a named case id.
- **D. Hardcoded:** In the scratch copy, perturb the source of truth in a *correct* way (add an enum member/registry entry, bump the version, change the default consistently) and run the test: the original must fail for no behavioral reason (false failure), or, perturbing in an *incorrect* way, stay green (false pass). Skip neither direction if both apply. After the fix, the same correct perturbation must keep it green and the incorrect one must turn it red.
- **Any category:** if a framework feature, REPL, or small script gives another way to check the claim (e.g. running the unit on the test's own inputs to see the test's expectation is an echo), use it. Plan and apply all mutants of all findings first (run protocol: one build, runtime switches, per-id runs, no fail-fast), then read results per finding. Discard scratch mutations afterward and verify the scratch copy is not what you report as the repo.

## Step 2: Apply, one finding at a time
- One finding = one atomic edit set. After each, run only the affected test ids per the run protocol (batch several findings into one build when their edits are done); keep a patch file of each change so it can be reverted in isolation (reverse-apply or `git checkout -- <test file>` when the file had no prior user changes).
- Never make a test pass by weakening it: no loosening assertions, adding skips, widening tolerances, or deleting a test that starts failing. A failing result after an edit means the edit or the finding was wrong - revert that finding and report it.
- Edit tests only. Do not modify production code, even when a rewritten test exposes a bug; report the bug.
- Match the existing test style and framework conventions; for deletions and merges keep any comment or issue reference that explains why a case exists.

## Step 3: Verify after all changes
1. Run the full suite once more the same way as the baseline (the only other full run; after each finding in Step 2 run only its affected test ids). Compare per-test:
   - Removed ids are exactly those you deleted/merged; added ids exactly those you introduced.
   - Every other test has the same status as before. No new failures, no new skips, no new warnings.
   - Arithmetic holds: baseline passes - removed + added = current passes (parametrized cases counted individually).
2. Coverage (if available): line and branch coverage overall and per touched file must be equal or higher than baseline. A drop means a deleted test was not redundant: restore it and mark that finding refuted.
3. If the framework supports random order or parallel runs, run once that way to check merged/parametrized tests did not introduce order dependence.
4. Any mismatch: bisect with your per-finding patches, revert the culprit, rerun. Do not finish with an unexplained difference.

## Step 4: Report
Per finding: `applied` / `refuted` / `skipped (reason)`, with the confirmation evidence (mutants run and their before/after results, coverage subset result, perturbation outcome, case-list match). For every A/B/D finding, list the mutants run, or the reason none were possible. Then before/after: test counts, pass/fail/skip, coverage, flaky tests excluded, pre-existing failures, parked patches (with paths), and any production bugs surfaced. State plainly anything you could not verify.
