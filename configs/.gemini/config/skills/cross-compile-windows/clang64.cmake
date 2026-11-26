# Cross-compile Windows binaries on Linux: system Clang/LLVM + MSYS2 CLANG64 sysroot (paths hardcoded).
# Use: cmake -G Ninja -DCMAKE_TOOLCHAIN_FILE=<this file> ...
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)

set(MSYS /mnt/windows/msys64)
set(SYSROOT ${MSYS}/clang64)

set(CMAKE_C_COMPILER /usr/sbin/clang)
set(CMAKE_CXX_COMPILER /usr/sbin/clang++)
set(CMAKE_RC_COMPILER /usr/sbin/llvm-windres)
set(CMAKE_AR /usr/sbin/llvm-ar)
set(CMAKE_RANLIB /usr/sbin/llvm-ranlib)
set(CMAKE_NM /usr/sbin/llvm-nm)
set(CMAKE_DLLTOOL /usr/sbin/llvm-dlltool)
set(CMAKE_LINKER /usr/sbin/ld.lld)

set(CMAKE_C_COMPILER_TARGET x86_64-w64-windows-gnu)
set(CMAKE_CXX_COMPILER_TARGET x86_64-w64-windows-gnu)

# The CLANG64 sysroot supplies headers, libs, libc++ and compiler-rt; its clang resource dir is the Windows one.
set(CMAKE_SYSROOT ${SYSROOT})
set(CMAKE_FIND_ROOT_PATH ${SYSROOT})
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER) # build-time tools (lua, magick, glslang...) come from the host
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
set(CMAKE_PREFIX_PATH ${SYSROOT})

set(CMAKE_C_FLAGS_INIT "--sysroot=${SYSROOT} -resource-dir=${SYSROOT}/lib/clang/23")
set(CMAKE_CXX_FLAGS_INIT "${CMAKE_C_FLAGS_INIT} -stdlib=libc++ -nostdinc++ -isystem ${SYSROOT}/include/c++/v1")
set(LINK_INIT "-fuse-ld=lld -rtlib=compiler-rt -unwindlib=libunwind -L${SYSROOT}/lib -stdlib=libc++")
set(CMAKE_EXE_LINKER_FLAGS_INIT "${LINK_INIT}")
set(CMAKE_SHARED_LINKER_FLAGS_INIT "${LINK_INIT}")
set(CMAKE_MODULE_LINKER_FLAGS_INIT "${LINK_INIT}")

# ctest runs .exe files through wine (see wine.sh).
set(CMAKE_CROSSCOMPILING_EMULATOR ${CMAKE_CURRENT_LIST_DIR}/wine.sh)

# Rust (Corrosion) target: x86_64-pc-windows-gnullvm, linked with the host clang.
set(Rust_CARGO_TARGET x86_64-pc-windows-gnullvm)
