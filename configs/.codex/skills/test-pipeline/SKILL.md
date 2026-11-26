---
name: test-pipeline
description: Run the test-quality pipeline on a repository - measure coverage and triage the gaps, write tests and refactors for the approved gaps, blind-review the suite for duplicate, vacuous, fragmented or hardcoded tests, and apply the review's fixes. Use whenever the user asks about test coverage, writing or adding tests, improving coverage, reviewing or auditing tests ("are these tests any good", "find useless tests"), applying test review findings, or the whole pipeline ("run the whole test pipeline", "do the full testing pass") - even if they name only one step. Any step can be skipped on request.
---

# Test Pipeline

Four steps. Each runs in its own fresh subagent, which reads only that step's file in `references/` plus the run protocol below, and works from the previous step's written output.

1. **coverage** (`references/coverage.md`): measure coverage, rank uncovered sites by risk, decide test / refactor / leave, write the verdict ledger. Writes no tests.
2. **write-tests** (`references/write-tests.md`): execute the approved ledger: refactors for testability, then tests and mocks, riskiest first, then re-measure coverage.
3. **review-tests** (`references/review-tests.md`): audit the suite for duplicate, vacuous, fragmented and hardcoded tests. Blind. Report only.
4. **fix-tests** (`references/fix-tests.md`): apply the review's findings, each confirmed empirically first. Only when the user wants them applied.

Why subagents: each step gets its own clean context and full budget, and works surgically from a written handoff instead of dragging along the previous step's reading. Why this order: decisions before implementation, and the audit judges the suite as it stands after implementation.

You are the orchestrator. Keep your own context thin: spawn, relay, ask the user, repeat. Do not read the source or do a step's work yourself.

## Choosing steps

Run the steps the user asks for, in the order above, and skip the rest. "Just review and fix", "only coverage" or "skip writing tests" means exactly that. Dependencies:

- write-tests needs an approved coverage ledger. Without one, run coverage first, or use the ledger the user names.
- fix-tests needs a review-tests report. Without one, run review-tests first, or use the report the user names.
- review-tests needs nothing: it audits the suite as it stands.

Name every skipped step in the final summary.

## Spawning rules (all steps)

Use the Agent tool with a **fresh general-purpose agent, never `subagent_type: "fork"`**. A fork inherits this conversation and defeats the clean-session point.

- **Host's model and effort.** Pass `model` equal to the model this session runs on, and `effort` equal to this session's current effort level when you know it. If you do not know the effort level, omit it rather than guess. Omitting `model` already inherits the host model.
- **Pass the minimum.** The step file to follow (`~/.claude/skills/test-pipeline/references/<step>.md`), the repository path, and the step's input (below). For steps that build or run tests, also point at the run protocol in this file (`~/.claude/skills/test-pipeline/SKILL.md`). No chat history, no summaries of what earlier steps did or found, no opinions.
- **Windows from Linux.** Only if the user says they want Windows tests built or run while on Linux (wine, cross-compile, MSYS2/CLANG64): tell every subagent that builds or runs tests (coverage, write-tests and fix-tests) to follow the `cross-compile-windows` skill (`~/.claude/skills/cross-compile-windows/SKILL.md`; source in `things/configs/.claude/skills/cross-compile-windows`) for the Windows side, covering both platforms in one pass. The blind review-tests step does not get it. Without that statement, do not pass it.
- **Linux from Windows.** Only if the user says they want Linux tests built or run while on Windows (WSL): tell every subagent that builds or runs tests (coverage, write-tests and fix-tests) to follow the `cross-compile-linux` skill (`~/.claude/skills/cross-compile-linux/SKILL.md`; source in `things/configs/.claude/skills/cross-compile-linux`). The blind review-tests step does not get it. Without that statement, do not pass it.
- **Subagents cannot reach the user.** Their final message is the report; it is not shown to the user. Relay it yourself, faithfully and without softening, before asking for anything.
- If a subagent hits a permission denial or cannot build or run tests, relay that to the user instead of working around it.

## Run protocol

Applies to every step that builds or runs tests. The step files point here.

- Edit first, build once. Finish every edit of the batch (tests, refactors, mutations) before the first build. Build only the test targets that contain touched tests, never `all`. Rebuild only after a new batch of edits, never to re-read output.
- Run by test id, not by executable. Re-run only tests added or changed since the last run that recorded results (the baseline counts), plus tests covering any production code just changed. Use the framework's per-case filter (`--gtest_filter`, `ctest -R`, pytest node ids, `cargo test <name>`, ...). Run everything only for the baseline and the final comparison.
- Never fail fast. Use the mode that runs all selected tests despite failures (no `-x`, `--stop-on-failure` or `--gtest_break_on_failure`; `cargo test --no-fail-fast`). Write per-test results (id -> pass/fail/skip) and output to a file in one run, then read the file; do not rerun to see output. Rerun a failure only by id and only to diagnose it.
- Mutation testing: put all mutants into one build, each behind a runtime switch (env var or argument read by the mutated code) so one build serves every mutant; run each mutant with only the tests that exercise its code, recording which tests fail. If switches are impractical, apply mutants on disjoint code together in one build and attribute failures by test id; mutants on the same code go in separate rounds. Mutating happens in a scratch copy, never the real tree.
- Test builds link against the user's Release packages (`-O3 -flto=full -ffat-lto-objects`) on Windows, or the system packages on Linux. The Release packages carry native code next to bitcode, so link the test binaries without `-flto` to skip the slow LTO link. Don't use the user's dynamic debug packages (`-O0`, very slow). Don't change the user's package configuration.
- Offscreen display. Any test that opens a window (GUI, X11, Qt, FLTK, wine) runs on an offscreen display, never the user's desktop: under `xvfb-run -a` with `WAYLAND_DISPLAY` unset on Linux/WSL or wine, and `QT_QPA_PLATFORM=offscreen` for Qt on any platform. Details and checklist: `cross-compile-linux` (WSL) and `cross-compile-windows` (wine).
- Test build flags: general builds use `-O3 -g` (debug info doesn't change runtime speed and keeps crash backtraces readable); coverage builds use `-O1`. All builds use `-march=native -mtune=native -pipe` and full parallelism (`ninja -j`).
- Build directories. Configure every build directory in the user's TEMP on Windows (`$env:TEMP`), or in `$HOME/.cache` on Linux. Never configure one in the repo tree.
- No GCC, ever. Build, test and coverage with clang and llvm tools only. The agent must never fall back to GCC (gcc, g++, gcov) in any circumstances. If clang or llvm-cov is missing or broken, stop and report it instead.
- Rust coverage. If the project has a Rust part (a `Cargo.toml` in the repo), measure Rust coverage with llvm-cov (`cargo llvm-cov`) every time, never another tool.
- Building test binaries is allowed; the Build and Verification rule still forbids a full app build.

## Step 1: coverage

Prompt: follow `~/.claude/skills/test-pipeline/references/coverage.md` on the repository at `<path>`; you are running as a subagent. Add the user's scope (a directory, a module) if they gave one.

It ends by returning the verdict table and the ledger path (default `<repo>/.claude/test-coverage-ledger.md`). Relay it and **ask the user for approval**: priorities, dropped items, and especially the production refactors. This is the pipeline's one planning gate. Record the user's edits in the ledger yourself if they are small (mark rows dropped, vetoed or reordered); for anything needing analysis, resume the step-1 agent with `SendMessage` and the edit request.

If it finds nothing worth covering, say so and skip step 2. Still run step 3 if tests exist.

## Step 2: write-tests

Only after approval. Prompt: follow `~/.claude/skills/test-pipeline/references/write-tests.md` on the repository at `<path>`; you are running as a subagent; the approved ledger is at `<ledger path>`. That is all: the ledger carries the plan, and the agent reads the code itself.

It returns the report from the step's section 5. Relay it. If it lists **Needs decision** items, ask the user, record the answers in the ledger, and resume the agent with `SendMessage` (or spawn a fresh write-tests agent on the updated ledger).

## Multiple chunks

Steps 1 and 2 work in chunks. If the report ends with remaining chunks under **Next**, do not loop on your own: ask the user whether to run another chunk. If yes, repeat steps 1-2 for the next chunk (a fresh agent each time, reading the same ledger), then continue. Run step 3 once, after the last chunk the user wants.

## Step 3: review-tests, blind

review-tests only works if the reviewer has not seen the implementation or anyone's knowledge of it. Steps 1 and 2 have read the source, so this agent must be isolated from all of it.

- **Prompt content, and nothing else:**
    - The instruction to follow `~/.claude/skills/test-pipeline/references/review-tests.md` fully, including its blind Phase 1.
    - The repository path and the test directories or files in scope. Locating them is fine; describing them is not.
    - Report only; it never edits tests. Fixing is a separate step (below).
- **Withhold everything else.** Do not pass: summaries or snippets of the source, what the code does, the ledger, the verdicts, which tests were just added or why, coverage numbers, refactors made, bugs found, or your opinion of test quality. Any of that biases the verdicts. The ledger lives under `.claude/` in the repo: do not point the subagent at it, and if it surfaces the file itself, it counts as contamination to note in its report.

Relay its report faithfully. It is the pipeline's final answer for this step. Do not re-review the tests or "correct" the subagent from source knowledge; if you disagree with a finding, add a clearly separate note after the report.

## Step 4: fix-tests (only if the user wants the findings applied)

Ask the user whether to apply the review's findings. If yes, spawn a fresh agent (same spawning rules) with: follow `~/.claude/skills/test-pipeline/references/fix-tests.md` on the repository at `<path>`; the review-tests report is at `<report path>` (or paste the report verbatim if no file was returned), scope as the user approved. Pass nothing else. Fixing needs source, so blindness no longer matters here. Relay its report faithfully.

## Final summary

End with a short combined report, one block per step that ran:

- **coverage:** coverage measured, verdict totals, the ledger path, what the user approved.
- **write-tests:** tests added, refactors and bugs fixed, coverage before -> after, where it stopped, unresolved Needs decision items.
- **review-tests:** findings per category, tests judged ok, contamination note.
- **fix-tests:** findings applied / refuted / skipped, before/after test counts and coverage, or "not run" if the user declined.

State plainly any step that was skipped, cut short or left waiting on the user.
