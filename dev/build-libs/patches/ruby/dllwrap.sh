#!/bin/sh
# Stand-in for dllwrap, which llvm-mingw doesn't ship. Ruby's static build only uses it to write its export file
# (`--output-exp=`), which is then passed to the linker, so write it as an empty COFF object the linker accepts.
for arg in "$@"; do
    case "$arg" in
        --output-exp=*) out="${arg#--output-exp=}" ;;
    esac
done
printf 'int ruby_exp_placeholder;\n' | i686-w64-mingw32-clang -c -x c - -o "$out"
