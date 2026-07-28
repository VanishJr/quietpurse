/**
 * Provider dictionary: the API returns stable slugs, the human-readable names live
 * here only — the same rule as the categories. 'upload' covers every statement the
 * user brought in themselves, whichever parser read it.
 */
export const PROVIDER_LABELS: Record<string, string> = {
  upload: 'Uploaded statement',
  monobank: 'Monobank',
  enablebanking: 'Connected bank',
};

/** Provider label; an unknown value is returned as-is (an older row, a new provider). */
export const providerLabel = (provider: string): string => PROVIDER_LABELS[provider] ?? provider;
