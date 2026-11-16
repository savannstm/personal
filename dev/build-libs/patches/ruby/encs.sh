#!/bin/sh
# Ruby 1.9 only. Run from the source root with CC/CFLAGS exported. The static ruby.exe can't dlopen enc/*.so and
# enc/trans/*.so, so compile every encoding and transcoder into objects (enc_objs.txt) and write the Init_ext glue
# that registers them under the .so names `require` looks for (enc_protos.inc, enc_calls.inc).
inc="-I. -I./include -I./.ext/include/i386-mingw32"
: > enc_protos.inc
: > enc_calls.inc
: > enc_objs.txt

# encdb/transdb first: they declare the lazily loaded encodings and transcoders. ascii, us_ascii, unicode and utf_8
# (and root newline.c) are already linked into ruby itself.
encs="encdb $(ls enc/*.c | sed 's|^enc/||; s|\.c$||' | grep -v -x -e encdb -e ascii -e us_ascii -e unicode -e utf_8)"
transes="transdb $(ls enc/trans/*.c | sed 's|^enc/trans/||; s|\.c$||' | grep -v -x -e transdb -e newline)"

for b in $encs; do
    # A file can define several encodings (big5.c), each with its own Init_<name> that dln would never call by itself.
    defs=$(sed -n 's/^OnigEncodingDefine(\([A-Za-z0-9_]*\),.*/\1/p' enc/$b.c)
    [ -n "$defs" ] || defs=$b
    flags=""
    calls=""
    for d in $defs; do
        flags="$flags -DInit_$d=Init_enc_$d"
        echo "void Init_enc_$d(void);" >> enc_protos.inc
        calls="$calls Init_enc_$d();"
    done
    $CC $CFLAGS -DONIG_ENC_REGISTER=rb_enc_register $inc $flags -c enc/$b.c -o encobj_$b.o || exit 1
    echo "static void initenc_$b(void) {$calls }" >> enc_protos.inc
    echo "ruby_init_ext(\"enc/$b.so\", initenc_$b);" >> enc_calls.inc
    echo encobj_$b.o >> enc_objs.txt
done

for b in $transes; do
    $CC $CFLAGS $inc -DInit_$b=Init_trans_$b -c enc/trans/$b.c -o transobj_$b.o || exit 1
    echo "void Init_trans_$b(void);" >> enc_protos.inc
    echo "ruby_init_ext(\"enc/trans/$b.so\", Init_trans_$b);" >> enc_calls.inc
    echo transobj_$b.o >> enc_objs.txt
done
