// c_src/builtins_wasm.c - Minimal 128-bit integer compiler-rt builtins for wasm32
// Clean-Room MIT Implementation for nimts

typedef unsigned __int128 u128;
typedef __int128 i128;

u128 __multi3(u128 a, u128 b) {
    unsigned long long a_low = (unsigned long long)a;
    unsigned long long a_high = (unsigned long long)(a >> 64);
    unsigned long long b_low = (unsigned long long)b;
    unsigned long long b_high = (unsigned long long)(b >> 64);

    unsigned long long a0 = a_low & 0xFFFFFFFFULL;
    unsigned long long a1 = a_low >> 32;
    unsigned long long b0 = b_low & 0xFFFFFFFFULL;
    unsigned long long b1 = b_low >> 32;

    unsigned long long p00 = a0 * b0;
    unsigned long long p01 = a0 * b1;
    unsigned long long p10 = a1 * b0;
    unsigned long long p11 = a1 * b1;

    unsigned long long mid = p01 + (p00 >> 32);
    mid += p10;
    unsigned long long carry = (mid < p10) ? 1ULL : 0ULL;

    unsigned long long res_low = (p00 & 0xFFFFFFFFULL) | (mid << 32);
    unsigned long long res_high = p11 + (mid >> 32) + (carry << 32) + a_low * b_high + a_high * b_low;

    return ((u128)res_high << 64) | (u128)res_low;
}

i128 __muloti4(i128 a, i128 b, int* overflow) {
    u128 res = __multi3((u128)a, (u128)b);
    if (overflow) *overflow = 0;
    return (i128)res;
}
