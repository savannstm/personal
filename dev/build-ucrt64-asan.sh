set -euo pipefail

TARGET=$(clang -dumpmachine)

if [ -d /c/msys64/home/savannstm/llvm ]; then
    echo "Already cloned"
else
    git clone --branch llvmorg-22.1.8 --depth 1 https://github.com/llvm/llvm-project /c/msys64/home/savannstm/llvm
fi

sd -s -- "if (COMPILER_RT_HAS_VERSION_SCRIPT)" "if (COMPILER_RT_HAS_VERSION_SCRIPT AND NOT MINGW)" "/c/msys64/home/savannstm/llvm/compiler-rt/lib/asan/CMakeLists.txt"
cd /c/msys64/home/savannstm/llvm/compiler-rt

cmake -B build -G Ninja . \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_COMPILER=clang \
    -DCMAKE_CXX_COMPILER=clang++ \
    -DCMAKE_C_FLAGS="-fuse-ld=lld" \
    -DCMAKE_CXX_FLAGS="-fuse-ld=lld" \
    -DCMAKE_SHARED_LINKER_FLAGS="-lstdc++" \
    -DCMAKE_AR=$(which llvm-ar) \
    -DCMAKE_RANLIB=$(which llvm-ranlib) \
    -DCMAKE_C_COMPILER_TARGET=$TARGET \
    -DCMAKE_CXX_COMPILER_TARGET=$TARGET \
    -DCMAKE_C_COMPILER_WORKS=1 \
    -DCMAKE_CXX_COMPILER_WORKS=1 \
    -DCOMPILER_RT_DEFAULT_TARGET_ONLY=TRUE \
    -DCOMPILER_RT_USE_BUILTINS_LIBRARY=TRUE \
    -DCOMPILER_RT_BUILD_BUILTINS=OFF \
    -DCOMPILER_RT_BUILD_SANITIZERS=ON \
    -DCOMPILER_RT_BUILD_XRAY=OFF \
    -DCOMPILER_RT_BUILD_PROFILE=OFF \
    -DCOMPILER_RT_BUILD_MEMPROF=OFF \
    -DCOMPILER_RT_BUILD_ORC=OFF \
    -DSANITIZER_CXX_ABI=libstdc++ \
    -DLLVM_CONFIG_PATH=$(which llvm-config) \
    -DCMAKE_INSTALL_PREFIX=/c/msys64/ucrt64/lib/clang/$(clang -dumpversion | cut -d. -f1) \
    --fresh

cmake --build build -j
cmake --install build