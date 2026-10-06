export type KnownDivergence = Readonly<{ name: string; run: () => Promise<void> }>;

export const knownDivergence: readonly KnownDivergence[] = [];
