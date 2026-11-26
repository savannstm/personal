// Ruby-style exception tags over ruby_setjmp/ruby_longjmp, which jumps.ts force-includes.
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct tag { jmp_buf buf; struct tag *prev; } tag_t;
static __thread tag_t *top;
static volatile long ensured;

__attribute__((noinline)) static void raise_(void) { ruby_longjmp(top->buf, 1); }

__attribute__((noinline)) static long deep(int n, long a, long b, long c, double x, double y) {
    char pad[64];
    memset(pad, n, sizeof pad);
    if (n == 0) raise_();
    return deep(n - 1, b, c, a + pad[5], y, x * 1.5) + a + b + c + (long)(x + y);
}

// Many live values in callee-saved registers (integer and XMM) across the setjmp, plus a variable-size frame.
__attribute__((noinline)) static long guarded(int n, long a, long b, long c, long d, double x, double y, double z) {
    volatile long keep = a * 31 + n;
    char *vla = __builtin_alloca((n & 15) + 17);
    memset(vla, 7, (n & 15) + 17);
#ifdef OVERALIGNED
    volatile double wide[4] __attribute__((aligned(32))) = {x, y, z, x};
    __asm__ volatile("" ::"r"(wide) : "memory");
#endif
    tag_t t;
    long caught = 0;
    t.prev = top;
    top = &t;
    if (!ruby_setjmp(t.buf)) {
        caught = (n & 3) ? deep(n % 9, a, b, c, x, y) : guarded(n / 4 - 1 > 0 ? n / 4 - 1 : 1, b, c, d, a, y, z, x);
    } else {
        caught = 1;
        ensured++;
    }
    top = t.prev;
    return caught + keep + a + b + c + d + (long)(x + y + z) + vla[16];
}

__attribute__((noinline)) static long expected(int n, long a, long b, long c, long d, double x, double y, double z) {
    long caught = (n & 3) ? 1 : expected(n / 4 - 1 > 0 ? n / 4 - 1 : 1, b, c, d, a, y, z, x);
    return caught + a * 31 + n + a + b + c + d + (long)(x + y + z) + 7;
}

int main(void) {
    for (int i = 1; i < 300000; i++) {
        volatile int n = i % 1000 + 1;
        long a = i, b = i * 3L, c = ~(long)i, d = i ^ 0x5555;
        double x = i * 0.5, y = i * 0.25, z = -i;
        long got = guarded(n, a, b, c, d, x, y, z);
        long want = expected(n, a, b, c, d, x, y, z);
        if (got != want || a != i || b != i * 3L || x != i * 0.5 || z != -i) {
            printf("mismatch at %d: %ld %ld\n", i, got, want);
            return 1;
        }
    }
    printf("ok, %ld raises\n", ensured);
    return 0;
}
