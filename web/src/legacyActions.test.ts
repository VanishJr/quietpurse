import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');

it('shares the complete danger pair with filled legacy destructive combinations', () => {
  const normal = css.match(/\.btn-destroy,\s*\.btn\.btn-danger\s*\{([^}]*)\}/)?.[1];
  expect(normal).toBeDefined();
  expect(normal).toContain('background: var(--ink-danger)');
  expect(normal).toContain('color: var(--ink-onDanger)');
  for (const [state, role] of [['hover', 'dangerHover'], ['active', 'dangerPressed']]) {
    const selector = `.btn.btn-danger:where(:not(:disabled, [aria-disabled='true'])):${state}`;
    const rule = css.slice(css.indexOf(selector)).match(/^[^{]+\{([^}]*)\}/)?.[1];
    expect(css).toContain(selector);
    expect(rule).toContain(`background: var(--ink-${role})`);
  }
});
