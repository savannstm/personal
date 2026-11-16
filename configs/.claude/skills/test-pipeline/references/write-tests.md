# Write Tests

Goal: turn the approved verdicts of the coverage step into tests where they buy the most safety, within the context budget, and leave a clear stopping point so the next session can resume.

Division of labor: the coverage step decides *what* is worth covering, how risky each site is, and which sites need a refactor or a mock. This step decides *how* to write it and does the work. Do not re-triage here; if you disagree with a verdict after reading the code, say so and adjust that row, do not silently reinterpret the plan.

Ground rules:

- **Work chunk by chunk.** Large codebases do not fit in context. Take the ledger's chunk, finish it, report, stop.
- **Never spawn your own subagents**, even if the user asks. Do the work yourself.
- **Production code is fair game.** The user writes code without tests in mind and plans to decouple it later, so tests are not meant to freeze the current structure. Any production change that makes the code testable, fuzzable or CI-friendly is allowed and encouraged, as listed in the ledger. See "Refactor for testability" below.

## 1. Get the ledger

Look for `<repo>/.claude/test-coverage-ledger.md` (or the path the user names). Read it fully, including its test/mock tooling, exclusions and **Next** list.

- **Ledger exists and the user approved it** (verdicts were posted and not vetoed): proceed with its chunk. If the user is continuing an earlier session, start where the ledger's "Stopped at" says.
- **No ledger:** run the coverage step first (`~/.claude/skills/test-pipeline/references/coverage.md`), which measures coverage, ranks risk, writes the ledger and stops for the user's go-ahead. Do not improvise your own triage. If the user only wants one small, explicitly named target (a file or function), a ledger with just those rows is enough, but it is still produced by that step.
- **Ledger looks stale** (code changed since, sites no longer exist or already covered): refresh the affected rows by re-running the coverage step for those files, rather than writing tests against a plan that no longer matches.

Match the project's test setup: framework, naming, layout, fixtures and assertion style. New tests should look like they were written by the same author.

## 2. Refactor for testability

Do any "Refactor, then test" rows first, since tests depend on them. When code that needs coverage is private, buried in a big function, or welded to I/O, globals or UI, do not contort the tests around it (friend hacks, `#define private public`, reflection, testing only through a distant public entry point). Change the code instead: make the logic reachable through a clean, deliberate API (a public function or module-level item, a pure core with a thin I/O shell, an injectable dependency). Tests written against a clean seam survive later refactors, and the same seam serves fuzzing and CI.

- Only refactors that the user approved in the ledger. A seam you discover is needed that is not in the ledger: stop and ask.
- Prefer the smallest refactor that creates the seam; behavior must stay identical. Run the existing suite (and the build checks the project allows) after refactoring to confirm nothing moved.
- Keep exposed APIs minimal and sensible for real callers, not test-only shims with awkward names, unless no cleaner shape exists.
- Update callers, docs and changelog entries the refactor touches, following project rules.

## 3. Write the tests

Work through the ledger in order, High first. If you run out of context or the session ends, the most valuable tests already exist.

**A row is the unit of work, and it is finished or not started.** A half-covered row is the worst outcome: the ledger says "handled", the site still has gaps, and nobody knows. So:

- Take one row, write everything its Plan lists (every branch, error path, mock/fake scenario named), then move on. Do not hop between rows, and do not write the easy half of a row and go on to the next.
- Before starting a row, judge whether you can finish it. Writing needs far more context than reviewing, so a big row may not fit what remains. If so, split it in the ledger first into explicit sub-rows (by function, branch group or scenario), each finishable alone, and do them as separate rows. Splitting is allowed; silently leaving part of a row is not.
- A row is **done** only when every item in its Plan has a test (or is explicitly moved to a new sub-row or to **Needs decision** with the reason) and the targeted lines/branches were confirmed hit in step 4. Mark status in the ledger per row: `done`, `split` (with the new sub-rows), `blocked` (reason), or `todo`. Never mark `done` for partial work.
- Stopping mid-ledger is fine, but only at a row boundary. Do not stop early because the list is long; the point of the ordering is that you keep going until the budget is really gone.
- Last check before reporting: re-read the ledger and list every row that is not `done`, with its status and reason. Any row you touched but did not complete must appear there, not be hidden in a summary.

- **Test this repo's code, never third-party libraries.** Every test must execute and assert the project's own logic. A test that builds a fixture and passes it to a dependency's API (parser, serializer, container, Qt/FLTK/Glaze call, etc.) and only checks what the library returns covers none of our lines - drop it, even if it looks like coverage of a "call site". Test the dependency boundary only where the project's own logic shapes what crosses it: the structure we build before handing it over, the validation/transformation we apply to what comes back, the error mapping we do. Then assert on that logic (the built structure, the mapped result), not on the library's behavior. Test: "if the library were replaced by a trivial stub, would this test still exercise our code and still be able to fail because of a bug in it?" If no, it is a library test.
- Assert behavior, not implementation. Every test must be able to fail: if you cannot name the bug it would catch, it is vacuous - drop it.
- Cover the interesting inputs: boundaries, empty/invalid input, error paths, and the branches the ledger flagged. One parametrized test beats many near-identical ones.
- Do not hardcode values that will go stale when unrelated code changes (counts of enum members, full lists, version strings) unless the value *is* the contract.
- If a test exposes a real bug, fix the production code right then, do not defer it to the report and do not bend the test to match the bug. Then prove the fix: the test must fail on the old code and pass on the fixed code (revert the fix or stash it, run, restore, run again), so the fix is shown to cure that exact bug and the test is shown able to fail. If the intended behavior is truly ambiguous (the code could be right and the expectation wrong), say so in the report instead of guessing.
- Follow the run protocol (`~/.claude/skills/test-pipeline/SKILL.md`): build once and run once per chunk, then only the changed test ids. Offscreen display: a test that opens a window runs under `xvfb-run -a` with `WAYLAND_DISPLAY` unset (Qt: `QT_QPA_PLATFORM=offscreen`), never on the user's desktop. Fix failures in your own tests; do not touch unrelated failing tests.

### Mocks and fakes

The ledger names the mock and fake sites and the tool to use; write them. If the ledger says no tool is wired in, ask before adding a dependency. A hand-written fake is fine when it is simpler than a mock library.

Fake the data the code consumes (canned parser input, stubbed config, a scripted sequence of responses) when that is enough; use a call-verifying mock only when the calls themselves are what you assert: "retries three times then gives up", "closes the handle on every path", "never writes when validation fails".

Do not mock the code under test or assert on internal calls that are implementation detail. A test that only restates the mock's setup is vacuous. Mock at the boundary, and let an injected interface, trait or callback from the refactor step carry it if the dependency was hardwired. You may add a mock site the ledger missed if you find one while reading the code; note it in the report.

## 4. Verify coverage

After running, re-run coverage for just the chunk's files and confirm the targeted lines and branches are now hit. A site that stays uncovered despite its test is a finding: say why (wrong seam, unreachable branch, the verdict was wrong). Update the ledger: mark rows done, record the new numbers, set **Stopped at**.

## 5. Report and stop

Stop after the chunk. Do not start the next one on your own - the user decides whether to continue here or in a clean session. End with a report that lets a fresh session resume without re-reading everything:

- **Done:** files/functions covered, tests added (where), coverage before -> after for those files. State "X of Y rows done"; every other row is listed below as `todo`/`split`/`blocked` with its reason.
- **Found and fixed:** bugs the tests revealed, the fix applied, and the fail-before/pass-after confirmation. Separately list suspicious behavior left unfixed because the intent was unclear.
- **Refactored:** production code changed for testability, with the reason.
- **Skipped on purpose:** rows left as Low/Skip, with the reason (from the ledger).
- **Stopped at:** the exact file and function (or line range) where this session ended.
- **Next:** the ledger's remaining chunks in priority order, each with its risk level, so the next session can start at the top.

Keep the report short and concrete; names and locations, not prose.

## Running as a subagent

When the pipeline spawns this step as a subagent, you start with no memory of the analysis: the ledger and the code are your only inputs, so read the sites it points to before writing. You cannot talk to the user. Anywhere this step says to stop and ask (a seam missing from the ledger, a dependency to add, an ambiguous expected behavior), stop that item, continue with the rest of the ledger, and put the question in your final report under **Needs decision** with the row it blocks. Your final message is the report from section 5; the orchestrator relays it.
