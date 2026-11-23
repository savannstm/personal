// Fast-fail CI check: one instruction from each x86-64-v3 family (AVX, AVX2, FMA, F16C, BMI1, BMI2, LZCNT, MOVBE).
// A runner without them dies here with STATUS_ILLEGAL_INSTRUCTION (0xC000001D), before any training or build starts.
#include <immintrin.h>
#include <stdint.h>
#include <stdio.h>

// Results go through volatile memory, so no intrinsic can be folded away and every instruction is really executed.
static volatile uint32_t isink[24];
static volatile float fsink[8];

int main(int argc, char* argv[]) {
    (void)argv;
    // argc, and the volatile bit count and mask, are unknown at compile time, so the BMI intrinsics stay real instructions
    const uint32_t b = (uint32_t)argc;
    volatile uint32_t vk = 4, vm = 0xF0;
    const uint32_t k = vk, m = vm;

    uint32_t u[8];
    float f[8];
    for (int i = 0; i < 8; i++) {
        u[i] = b + (uint32_t)i;
        f[i] = (float)((b + (uint32_t)i) & 15);  // small integers, exact through F16
    }

    __m256i ints = _mm256_loadu_si256((const __m256i*)u);                     // VMOVDQU (AVX)
    __m256i perm = _mm256_permutevar8x32_epi32(ints, _mm256_set1_epi32(7));  // VPERMD (AVX2)
    _mm256_storeu_si256((__m256i*)(void*)isink, _mm256_add_epi32(ints, perm));  // VPADDD (AVX2)

    __m256 x = _mm256_loadu_ps(f);
    __m256 y = _mm256_fmadd_ps(x, x, x);                                      // VFMADD213PS (FMA)
    _mm256_storeu_ps((float*)(void*)fsink, _mm256_cvtph_ps(_mm256_cvtps_ph(y, 0)));  // VCVTPS2PH / VCVTPH2PS (F16C)

    isink[16] = _andn_u32(b, m);                                              // ANDN (BMI1)
    isink[17] = _blsr_u32(b | 8);                                             // BLSR (BMI1)
    isink[18] = _bzhi_u32(b, k);                                              // BZHI (BMI2)
    isink[19] = _pdep_u32(b, m);                                              // PDEP (BMI2)
    isink[20] = _lzcnt_u32(b);                                                // LZCNT
    isink[21] = (uint32_t)_loadbe_i32(u);                                     // MOVBE

    const float v = (float)(b & 15);
    int bad = 0;
    bad |= isink[7] != 2 * b + 14;
    bad |= fsink[0] != v * v + v;
    bad |= isink[16] != (~b & m);
    bad |= isink[17] != ((b | 8) & ((b | 8) - 1));
    bad |= isink[18] != (b & ((1u << k) - 1));
    bad |= isink[19] != ((b & 0xF) << 4);
    bad |= isink[20] != (b ? (uint32_t)__builtin_clz(b) : 32u);
    bad |= isink[21] != __builtin_bswap32(b);

    if (bad) {
        puts("x86-64-v3 check: wrong results");
        return 1;
    }
    puts("x86-64-v3 check: ok");
    return 0;
}
