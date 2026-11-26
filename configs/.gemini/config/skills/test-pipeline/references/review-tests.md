# Review Tests

Audit an existing test suite and report defective tests. It produces a report and edits nothing; applying fixes is the job of the fix-tests step, which takes this report as input.

## Why this is a two-phase, blind review

A reviewer who has read the implementation rationalizes every test ("it asserts 42, and the function does return 42"), which is exactly the failure being hunted: tests written to agree with the code. Judge each test as a stranger with only the test file would: does it, alone, state a behavior and fail if that behavior breaks?

- **Phase 1 (blind):** evaluate every test using test files only. Produce a frozen ledger.
- **Phase 2 (source-assisted):** open source only to answer specific questions queued by Phase 1. Phase 2 cannot talk you out of Phase 1 findings.

Do not start Phase 2 until Phase 1 has covered every test in scope. Partial evaluation lets early source reading bias later verdicts.

## Phase 1 - blind rules

**Allowed to read:** test files, test helpers/fixtures/data/golden files, test runner config (to see skips, markers, timeouts), and directory listings.

**Forbidden until the ledger is frozen:**
- Any non-test file: implementation, headers, README/docs/CHANGELOG, comments in source.
- Tools that surface source indirectly: `codegraph_explore`, LSP `goToDefinition`/`hover`/`findReferences` landing in non-test files, `git show`/`git log -p` of non-test files, repo-wide `rg` whose hits include source (scope searches to test directories), coverage reports that print source lines.
- Inline test modules living inside source files (Rust `#[cfg(test)]`, D `unittest`, Python doctests): read only the test region (line range), never the surrounding code.

If something forbidden leaks into context anyway, note it under "Contamination" in the report and do not use it for Phase 1 verdicts.

You are prohibited from spawning your own subagents. Do the review yourself.

### Completeness contract (read this before starting)
The review only counts if it covers the whole suite; a partial review leaves unjudged tests the user cannot identify. Reading test code is cheap, so do not decide the suite is "too big" or stop at a sample.

- **Every test gets its own ledger row.** No "representative sample", "similar tests omitted", "remaining tests follow the same pattern", or one row standing for a group. Many near-identical tests are the very thing check C looks at; they still each get a row (a terse one is fine).
- **Judge file by file, writing rows as you go.** Read one test file, append its rows to the ledger file immediately, then move to the next. Do not read everything first and plan to judge afterwards; by then the early files are a blur and the temptation to skim is strongest. Tests you have read but not yet written down count as unreviewed.
- **Terse is fine, skipped is not.** `ok` rows need only the purpose sentence. If context runs out (compaction), the ledger file holds your progress: continue from the first test id with no row.
- **Mechanical gate.** The inventory (Step 1) fixes N, the number of test cases. Before declaring Phase 1 complete, count ledger rows and compare to N (e.g. `rg -c` on the ledger vs. the inventory file) and list every inventory id with no row. Any gap means Phase 1 is not complete: go back and judge those tests. Only the gate passing - rows == N, nothing unreviewed - lets you state "Phase 1 complete".

### Step 1: inventory
Find test files by convention (`tests/`, `test_*.py`, `*_test.go`, `*.spec.ts`, `*Test.java`, `*_test.cpp`, ...). List every test case, including parametrized cases and those disabled/skipped (record skip reasons; a permanently skipped test is a finding of its own). Write the inventory to `<repo>/.claude/test-review-inventory.txt` (one id per line, `file:line test id`) and note N. This file is the checklist the completeness gate runs against, so produce it with a search command (`rg` for the framework's test macro/decorator), not from memory.

### Step 2: state each test's purpose
For every test write one sentence: *"Verifies that <unit> <does/returns/rejects X> when <condition>"*, derived from its name and body. If you cannot write that sentence from the test alone, that is a finding (unclear/vacuous), not something to resolve by reading source. Purposes are the unit of comparison for everything below.

### Step 3: apply the four checks

**A. Duplicates.** Two tests are duplicates when, after normalizing names and irrelevant literals, they share arrange + act + assertion and would fail for the same regressions.
- *Exact:* same setup, same call, same assertions.
- *Subsumed:* test A's setup and act are the same as B's and A's assertions are a subset of B's.
- *Cross-layer:* a unit test and an integration test pinning the identical behavior with the identical failure signal.
- Not duplicates: same code path with inputs from different equivalence classes or boundaries; same call asserting a different property; tests whose failure would point to different causes.
- Decision test: "If I deleted this test, which plausible regression would go undetected?" None = duplicate.

**B. Tests that exist to satisfy the code (vacuous / tautological / change-detector).** Flag when any holds:
- No assertion; or assertion always true (`assert x is not None`, `assert True`, truthiness-only checks of a value that is never falsy; assertions inside a loop/branch that may never execute).
- Expected value computed by the unit under test itself (`assert f(x) == f(x)`), by a re-implementation of its algorithm inside the test, or pasted from a one-time dump of actual output (snapshot/golden accepted blindly, no independent oracle).
- The unit under test is mocked, or the only thing asserted is mock interaction/return values the test itself configured.
- Tests a third-party library instead of the project: builds input, calls the dependency's API, and asserts only what the library does, so no project line is exercised beyond the call itself. Not this defect: tests of project logic that shapes the data going into or coming out of the library (built structure, validation, error mapping). Decision test: replace the library with a stub; if nothing project-specific is left to fail, flag it for deletion.
- Asserts private state, call order, or call counts of internals when the name claims observable behavior.
- Name/docstring promises X but assertions check Y or something weaker.
- Pins evident wrong behavior ("current behavior", unexplained magic expected values with no derivation).
- Swallows failure: broad `try/except`, `expect_err` without checking which error, `assertRaises(Exception)`.
- Mutation question: name one plausible bug in the behavior described by the test's purpose sentence. If the test would still pass, it is vacuous. Write that bug in the finding as evidence.

**C. Fragmentation.** Tests are fragmented when they share the same unit, act, and assertion shape, differ only in literal inputs/expected values, and their purpose sentences are identical once literals are abstracted ("rejects malformed input"). Recommend one parametrized/table-driven test with readable case ids. Also flag the split-arrange form: several tests repeat the same expensive setup and call to assert one field each of the same result.
- Preserve semantic purpose. Do NOT recommend merging when purposes differ: success vs error path, different contracts or states, cases where a distinct failure name matters for diagnosis, or cases documenting a specific past bug. Say which purposes you compared.
- Over-merged tests (one test, many unrelated behaviors, first failing assertion hides the rest) are reported separately as "overloaded", lower priority.

**D. Hardcoded / staleness-blind tests.** A literal is a defect when it copies a value that has a source of truth elsewhere in the repo, so the test either breaks for no behavioral reason or keeps passing after real change. Look for:
- Counts and enumerations of what the system provides (`len(registry) == 7`, full list of supported formats/enum members/CLI flags/plugins).
- Version strings, config defaults, limits, ports, paths, URLs, error/UI message text copied from the implementation, translation strings.
- Time, locale, timezone, cwd, absolute paths, unseeded randomness, hash/dict/set/filesystem iteration order, network, machine-specific env.
- Expected values that must be edited whenever an unrelated feature is added.
- Decision test: "Would a correct change (new enum member, bumped version, changed default) fail this test? Would an incorrect change leave it green?" Yes to either = defect.
- A literal is CORRECT when it is an independent oracle: spec/protocol constants, file-format magic bytes, public-contract strings, hand-computed expected results, plain test inputs. Do not flag these. A literal alone is never a finding; the finding is a literal that duplicates repo state the test could import or derive.

### Step 4: ledger and gate
Write the ledger to `<repo>/.claude/test-review-ledger.md` (create the directory; it stays untracked, do not commit it; never read `test-coverage-ledger.md`): one row per test - `file:line | test id | purpose sentence | verdict (ok / A / B / C / D, several allowed) | evidence | Phase-2 question or "none"`. Mark verdicts **certain** (decidable from tests alone) or **candidate** (needs source). Tests resolved only by reading source are always `candidate`.

Run the completeness gate first (rows == N, no inventory id missing). State "Phase 1 complete, N of N tests reviewed, ledger frozen" only when it passes; if it cannot, say how many are unreviewed and which, and do not proceed to Phase 2 or the report as if the review were whole.

## Phase 2 - source-assisted verification

Now source may be read, but only to answer queued questions, one lookup per question. Allowed uses:
1. D-candidates: find the source of truth of a suspected hardcoded value and name it (file:symbol) so the recommendation is concrete ("derive from `X` instead of literal 7").
2. B-candidates: confirm a test mirrors the implementation's algorithm, or that its mock replaces the unit under test.
3. A-candidates: refute a duplicate only if source shows the inputs hit behaviorally different branches (cite them).

Constraints:
- Phase 1 findings and purpose sentences are not revised because the implementation does what the test asserts - that agreement is the symptom, not the defense.
- A downgrade needs an explicit reason and is recorded as "downgraded in Phase 2: ...". Never delete a ledger row silently.
- New findings from Phase 2 are tagged `phase-2` so the reader sees what blind review alone would have missed.
- Do not hunt for missing tests or review production code; out of scope. Mention unrelated defects (flakiness from shared state, order-dependence) only as one-line "also noticed".

## Report

Deliver in the reply, grouped by category A-D, most actionable first:

```
### <Category> (<n> findings)
- `path:line` `test_name` [certain|probable] [phase-1|phase-2]
  Evidence: <quote the line / the bug that would still pass>
  Fix: <delete / merge into `other_test` / parametrize over {...} / replace literal with `Symbol` / add independent oracle>
  Still covered after fix: <behavior that remains protected> (required for delete/merge)
```

Close with: "N of N tests reviewed", totals per category, count of tests judged ok, the Contamination note (or "none"), and what was not reviewed (unreadable files, skipped dirs; must be "nothing" unless a file was truly unreadable). Only report findings you can back with quoted evidence; a suite with few defects should produce a short report. Also write the report to `<repo>/.claude/test-review-report.md` and give its path in the final message, so the fix-tests step can take it as input. End by offering the fix-tests step in one line.
