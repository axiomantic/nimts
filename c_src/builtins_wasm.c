// c_src/builtins_wasm.c - Minimal 128-bit integer compiler-rt builtins for wasm32
// Clean-Room MIT Implementation for nimts

void __multi3(unsigned long long* res, unsigned long long a_low, unsigned long long a_high, unsigned long long b_low, unsigned long long b_high) {
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

    res[0] = (p00 & 0xFFFFFFFFULL) | (mid << 32);
    res[1] = p11 + (mid >> 32) + (carry << 32) + a_low * b_high + a_high * b_low;
}

void __muloti4(long long* res, long long a_low, long long a_high, long long b_low, long long b_high, int* overflow) {
    __multi3((unsigned long long*)res, (unsigned long long)a_low, (unsigned long long)a_high, (unsigned long long)b_low, (unsigned long long)b_high);
    if (overflow) *overflow = 0;
}
