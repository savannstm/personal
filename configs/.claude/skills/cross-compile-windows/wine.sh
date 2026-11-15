#!/bin/sh
# CMAKE_CROSSCOMPILING_EMULATOR: run a Windows .exe under wine on a virtual X display.
# WINE_BUILD_DIR: build root holding DLLs the tests load (e.g. Rust cdylibs); added to WINEPATH when set.
# The MSYS2 CLANG64 runtime DLLs are always on WINEPATH.
WINEPATH="Z:/mnt/windows/msys64/clang64/bin"
[ -n "$WINE_BUILD_DIR" ] && WINEPATH="Z:$WINE_BUILD_DIR;$WINEPATH"
export WINEPATH
export WINEDEBUG="${WINEDEBUG:--all}"
exec xvfb-run -a wine "$@"
