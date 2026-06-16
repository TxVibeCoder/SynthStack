declare module 'fft.js' {
  /** indutny/fft.js — radix-4 FFT (MIT). Test-only dependency (work order Appendix D). */
  export default class FFT {
    constructor(size: number);
    readonly size: number;
    createComplexArray(): number[];
    toComplexArray(input: ArrayLike<number>, storage?: number[]): number[];
    fromComplexArray(complex: number[], storage?: number[]): number[];
    completeSpectrum(spectrum: number[]): void;
    transform(out: number[], data: number[]): void;
    realTransform(out: number[], data: ArrayLike<number>): void;
    inverseTransform(data: number[], spectrum: number[]): void;
  }
}
