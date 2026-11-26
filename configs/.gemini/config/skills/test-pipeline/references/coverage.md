# Coverage step

Goal: turn a coverage report into decisions. Not "raise the percentage", but for every uncovered site: is a test worth it, is a refactor worth it, or is the gap fine? The output is a ledger of verdicts. Writing the tests and refactors is the job of the write-tests step, which takes this ledger as its input; this step stops once the ledger is posted and approved.

Ground rules:

- **Analysis only.** Do not write tests, mocks or production changes here. Keeping analysis and implementation apart means the decisions are made once, with the whole chunk in view, and the user can redirect them before any code changes.
- **Never spawn your own subagents.** (The pipeline may run this step as one; see "Running as a subagent".)
- **Chunk by amount of uncovered code, not project size.** Models are overly cautious here: do not assume a big project must be read in small pieces, and do not try to read your own context usage. Size the chunk by how much uncovered, risky code there is: a well-tested 30k-line project may fit whole in one pass (past runs on 20-30k SLoC stayed under ~400k tokens), while a project with little or no testing would choke if done in one go, so take the highest-risk part, about half the context. If the write-tests step will run in the same session, it shares that budget; if it runs in its own fresh session (as under the pipeline), only make the ledger rows precise. Keep the chunk coherent (code sharing types and invariants), and prefer the chunk with the highest-risk uncovered code over the biggest gap.

## 1. Detect the setup and measure

Find out what is wired in: test framework, test directories, how tests run (build files, CI config, README, package scripts), what coverage tooling exists. Prefer targeted searches over browsing the tree. No tests or coverage tooling wired in: say so and ask before adding any.

If an earlier ledger exists (see "Ledger" below), read it first and continue from its "Next" list instead of re-deriving the plan.

Run the suite once, following the run protocol (`~/.claude/skills/test-pipeline/SKILL.md`), including its offscreen-display rule (window-drawing tests run under `xvfb-run -a` with `WAYLAND_DISPLAY` unset, never on the user's desktop), with **line, branch and function coverage** using the toolchain's native tool (llvm-cov for C and C++, coverage.py/pytest-cov, c8/istanbul, go test -cover, ...; Rust always `cargo llvm-cov`, and never GCC/gcov, per the run protocol). Branch coverage matters because a line can be hit while its error path never runs. Sort by where the uncovered code sits and how much of it there is, not by the headline percentage.

- If the suite already covers everything that matters, say so and stop. Do not pad coverage to hit a number.
- If the suite fails before coverage can be measured, report that rather than fixing unrelated failures.

### Excluded: shared C++ headers

These shared headers are already tested in their own repository, <https://github.com/savannstm/personal> (branch `main`, in the `cpp-headers` directory; tests in `cpp-headers/tests/Tests.cpp`):

`Dialog.hpp/.cpp`, `Filesystem.hpp/.cpp`, `Hasher.hpp`, `Logger.hpp/.cpp`, `Numbers.hpp`, `PackedBits.hpp`, `QtNumbers.hpp`, `QtStrings.hpp/.cpp`, `StringBuilder.hpp`.

Also in that repo but only type aliases, so nothing to test: `Aliases.hpp`, `QtAliases.hpp`.

If a C++ project includes, vendors or copies any of them, do not count their uncovered lines as gaps. Ignore them in the coverage report and note in the ledger that they were excluded for that reason.

The list can go stale. When a project contains a header that is not on it but looks like it came from that repo (same name, same style), check the repo's file list (`gh api repos/savannstm/personal/contents/cpp-headers` or the web page) and see whether `tests/Tests.cpp` includes it. If the repo has it and tests it, treat it as excluded. If the repo has it untested, say so in the ledger instead of planning tests for it here. If the repo cannot be reached, keep to the list above.

## 2. Inspect the uncovered sites

Take exact locations from the report (file, function, line range, branch) and read each uncovered site **together with enough surrounding code** (callers, types, invariants) to know what it actually does. Do not guess behavior from names or percentages. Group sites that share a cause, for example "all the error paths of `load()`", so the decision is made once per group.

For each site, find out *why* it is uncovered, because the reason determines the remedy:

- **Simply untested:** reachable through the public API with plain inputs.
- **Needs a fake:** reachable only when a collaborator fails, is slow or is nondeterministic (I/O errors, timeouts, clocks, randomness, OS state).
- **Structurally unreachable by tests:** private, buried in a long function, welded to UI/globals/I/O, so a test cannot get at it without hacks (`#define private public`, friend, reflection, driving it through a distant entry point).
- **Dead or impossible:** unreachable by construction, or a defensive guard. Mention dead code, do not delete it unasked.

## 3. Rank by risk

Rank by how bad it is if the code is wrong and how likely it is to be wrong.

**High** - code where a bug would be severe or hard to notice:
- Can crash or corrupt state: pointer/index arithmetic, unchecked or `unsafe` operations, buffer handling, lifetime and ownership, manual resource management.
- Can lose or damage data: serialization/parsing, file and database writes, migrations, merges, deletion, overwrite logic.
- Behaves unexpectedly: parsers and state machines, boundary conditions (empty, one, max, off-by-one), numeric conversion and overflow, encoding, time and timezone.
- Intermittent "sometimes happens, sometimes not": concurrency, ordering assumptions, caches, global or shared mutable state, anything depending on iteration order or timing.
- Security- or money-sensitive logic, and anything that other code relies on silently (shared utilities).

**Medium** - real logic with limited blast radius: branching business rules, error-handling paths that are reachable in normal use (bad user input, missing file, malformed data), conversions between types.

**Low** - code you can verify by reading in seconds: getters/setters, thin wrappers and forwarding, constructors that just assign, constants, plain formatting, straight-line glue.

**Skip** - third-party library internals and behavior: never plan tests whose only subject is a dependency's API. A site that is just a call into a library with no project logic around it is Low/Skip; plan tests only for the project logic that builds the library's input or handles its output. Also skip cases that are technically failures but only occur in environments you cannot meaningfully simulate or whose handling is "report and bail": disk full, out-of-memory, hardware faults, impossible-by-construction states guarded by an assertion, third-party library failures you cannot trigger.

Quick test: *would a person reading this code need to reason to know what it does and what could go wrong?* If yes, High or Medium. If it is obvious at a glance, Low.

## 4. Decide: test, refactor, or leave

Judge by value, not by count: risk against the cost of covering the site.

| Verdict | When |
|---|---|
| **Test** | Reachable (directly or via a mock/fake) and Medium or High risk, or Low risk and nearly free. |
| **Refactor, then test** | High or Medium risk, and covering it needs hacks, **and** the refactor is small relative to the safety gained. |
| **Leave** | Low risk with no real signal to gain, Skip-class failures, impossible states. State why. |

A refactor is worth it when it is the cheapest way to cover risky logic *and* the resulting seam is a sensible API on its own: a pure function pulled out of an I/O or UI function, an injected dependency, a split of a large function, logic moved to its own unit. The user writes code without tests in mind and plans to decouple it later, so production changes that make code testable, fuzzable or CI-friendly are welcome. A refactor is not worth it when it is large, touches many callers for little coverage, or only exists to chase a Low-risk line. Behavior must stay identical; name the smallest seam that works. If a refactor removes the need for a mock, or a mock removes the need for a refactor, take the cheaper one.

### Mock and fake sites

**Mocking is encouraged.** Actively hunt for mock and fake sites rather than waiting to be told, by looking at I/O, time and failure-path boundaries across the chunk, not only at what the coverage report flags:

- Failure paths a real dependency will not produce on cue: a read that fails halfway, a write error, a network timeout, a malformed response, a partial read.
- Interactions that are the contract: "retries three times then gives up", "closes the handle on every path", "never writes when validation fails", call order and arguments.
- Time, randomness, clocks, environment and OS state, so tests become deterministic.
- Filesystem, network, database, process, device and UI boundaries, so the logic above them runs without the real thing.

Record the tool to use (the project's mocking tool, a hand-written fake, or "none wired in, ask before adding a dependency") and whether a data fake or a call-verifying mock fits; the write-tests step has the rules for writing them. Do not plan mocks of the code under test or of cheap, deterministic code (pure functions, value types, in-memory structures). If the dependency is hardwired, the seam (injected interface, trait, callback) is a "Refactor, then test" item.

## 5. Write the ledger

The ledger is the handoff to the write-tests step, so make it complete enough that a fresh session can implement it without redoing the analysis. Write it to `<repo>/.claude/test-coverage-ledger.md` unless the user names another place (create the directory; it stays untracked, do not commit it). One row per site or group:

```
| Site (file:lines / function) | Why uncovered | Risk | Verdict | Plan: what the test asserts, which seam or mock/fake |
```

Above the table: the coverage numbers measured (line / branch / function, overall and for the chunk's files), the exclusions, the test/mock tooling to use, and the chunk boundary. Below it: **Left on purpose** (Low/Skip sites with reasons, so the user can disagree) and **Next** (remaining uncovered chunks in priority order, each with its risk level), so a later session can start at the top.

Order rows High first. Order matters downstream: if the writing session ends early, the most valuable tests already exist.

## 6. Post the verdicts and stop

Reply with the table (or a compact version of it), totals per verdict, the expected coverage gain for the chunk, the ledger path, and any refactors that need approval (these change production code). **Stop for the user's go-ahead.** They may redirect priorities, drop items or veto refactors; apply their changes to the ledger. Then hand over to the write-tests step, which executes the approved ledger.

Do not start writing tests or the next chunk on your own.

## Running as a subagent

When the pipeline spawns this step as a subagent, you cannot talk to the user. Do steps 1-5 as written, then make step 6 your **final message**: the verdict table, totals, expected gain, the ledger path and the refactors needing approval. The orchestrator relays it to the user and brings back their edits. Write the ledger so it stands alone: the next agent starts with no memory of this session, only the ledger and the code.
