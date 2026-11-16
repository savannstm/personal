---
name: cross-compile-linux
description: Configure, build and run Linux test binaries from this Windows machine by driving the Debian WSL distro (CMake + Ninja, system clang, ctest under xvfb-run). Use whenever the user wants a Linux build, Linux test run or Linux coverage from Windows, or mentions WSL, WSLg, Debian or running tests on Linux. Also use before running any test that opens a window, to make sure it gets an offscreen display.
---

# Build and test Linux from Windows (WSL)

Target: the `Debian` WSL 2 distro, using its system packages only: no msys64, no `set-env.ts`, no Windows toolchain inside WSL. Build test targets only (no full app build).

## Running commands in WSL

- From the Bash tool, pipe a heredoc into WSL; the quoted `'EOF'` keeps `$(nproc)` and friends for WSL's shell:
    ```
    wsl -d Debian -- bash -s <<'EOF'
    ...commands...
    EOF
    ```
- From PowerShell, pipe a single-quoted here-string: `@'` ... `'@ | wsl -d Debian -- bash -s`. The closing `'@` goes at column 0.
- Windows drives are under `/mnt/<lowercase letter>/`: `F:\Repos\<repo>` is `/mnt/f/Repos/<repo>`.

## Prerequisites (check first, stop and report if missing)

```
LLVM=$(ls -d /usr/lib/llvm-*/bin | sort -V | tail -1)
for t in cmake ninja "$LLVM/clang" "$LLVM/clang++" xvfb-run Xvfb; do
  command -v "$t" >/dev/null || echo "MISSING: $t"
done
```

`LLVM` is the newest LLVM from the LLVM apt repository (`/usr/lib/llvm-<N>/bin`). Use it for the compiler and LLVM tools instead of unversioned names: the repository does not guarantee `clang` on PATH. Each WSL session starts fresh, so set `LLVM` again in every script.

Needed: `cmake`, `ninja`, the repository's `clang-<N>` (through `$LLVM`), `xvfb` (provides `xvfb-run` and `Xvfb`), `xauth`. For coverage also `$LLVM/llvm-profdata` and `$LLVM/llvm-cov`. Do not install packages yourself; report what is missing so the user can run `sudo apt install ...`.

Clang is always the GNU-style frontend: use `clang`/`clang++`, never `clang-cl`.

## Configure

```
cmake -G Ninja -S /mnt/f/Repos/<repo> -B ~/.cache/<name>-linux \
  -DCMAKE_C_COMPILER="$LLVM/clang" -DCMAKE_CXX_COMPILER="$LLVM/clang++" \
  -DCMAKE_BUILD_TYPE= \
  -DCMAKE_CXX_FLAGS="-O2 -g -march=native -mtune=native -pipe" \
  -DCMAKE_C_FLAGS="-O2 -g -march=native -mtune=native -pipe"
```

- Build dirs go in the WSL home (`~/.cache/<name>-linux`), never under `/mnt`: the Windows-mounted filesystem is far slower and writes files into the repo's tree.
- `CMAKE_BUILD_TYPE` is left empty so the flags above are the only optimization/debug settings. A `Debug` type would add `-O0` after them.
- Use system pkg-config as-is; do not set `PKG_CONFIG_*` variables.

## Build

```
ninja -C ~/.cache/<name>-linux -j"$(nproc)" <test-target> [<test-target> ...]
```

Name only the test targets that contain touched tests, never `all`. Follow the run protocol in `test-pipeline` for batching edits before the build.

## Run tests (offscreen display is mandatory for window-drawing tests)

Run the whole ctest invocation under `xvfb-run`, so every test it launches inherits the virtual display:

```
wsl -d Debian -- bash -s <<'EOF'
env -u WAYLAND_DISPLAY xvfb-run -a -s "-screen 0 1920x1080x24" \
  ctest --test-dir ~/.cache/<name>-linux -j"$(nproc)" -R '<ids>' \
  --output-junit ~/.cache/<name>-linux/results.xml
EOF
```

- `-a` picks a free display number for this run only; `-s` sets a 24-bit screen (the default 8-bit depth breaks some toolkits).
- Run by test id (`-R`), never fail fast: plain `ctest` continues past failures, so do not add `--stop-on-failure`.
- If GUI tests fail only under `-j`, rerun just those ids serially: `ctest --rerun-failed -j1` under the same `xvfb-run` wrapper. Count a test as unverified if it only fails under parallel load and was not rerun serially.

## Offscreen display: the checklist for any test that opens a window

WSLg is active in this distro: every WSL session inherits `DISPLAY=:0` and `WAYLAND_DISPLAY=wayland-0`. A test run without overrides draws on the user's real desktop. Before running any test, ask: does it open a window (GUI, X11, FLTK, Qt, GTK, SDL, wine, or a browser)? If yes:

1. Wrap the run in `env -u WAYLAND_DISPLAY xvfb-run -a -s "-screen 0 1920x1080x24"`. Unsetting `WAYLAND_DISPLAY` matters: Qt and GTK prefer Wayland when it is set, and that opens windows on the desktop even though `DISPLAY` points at Xvfb.
2. For Qt tests, also set `QT_QPA_PLATFORM=offscreen` (it draws nothing and needs no X server). Keep xvfb for X11 toolkits (FLTK, GTK, SDL) and for anything that asserts on real X windows.
3. Never run a window-drawing test binary directly or through a bare `ctest`.
4. Check the display before trusting the run: `env -u WAYLAND_DISPLAY xvfb-run -a sh -c 'echo "$DISPLAY"'` must print a `:NN` number, not `:0`.

## Coverage (only when the user asks)

Add `-fprofile-instr-generate -fcoverage-mapping` to the compile flags and `-fprofile-instr-generate` to the link flags. Set `LLVM_PROFILE_FILE=<dir>/%p.profraw` (per-process `%p`). Merge with `$LLVM/llvm-profdata merge`, report with `$LLVM/llvm-cov report` / `show`, using the same binaries that were built. Verify the tools exist first. Expect "mismatched data" warnings for some inline functions: their counts may be low. A crashed process writes no profile.

## Gotchas

- Build dirs and `results.xml` stay in `~/.cache`; the repo tree must not gain build output.
- The compiler is the newest LLVM from the LLVM apt repository, not the CLANG64 toolchain used by `cross-compile-windows`. Never reuse a build dir between them.
- If CMake cannot re-run after a path change, reconfigure with the same command; do not hand-edit `CMakeCache.txt`.
