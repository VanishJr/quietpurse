/** 'upload' covers every statement the user brought in themselves, whichever parser read it. */
export const PROVIDER_LABELS: Record<string, string> = {
  upload: 'Uploaded statement',
  monobank: 'Monobank',
  enablebanking: 'Connected bank',
};

export const providerLabel = (provider: string): string => PROVIDER_LABELS[provider] ?? provider;
