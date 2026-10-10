import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// The browser-check recipe installs playwright-core outside the repository.
const require = createRequire('/tmp/quietpurse-check/pw/package.json');
const { chromium } = require('playwright-core');
const browser = await chromium.launch({
  executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  headless: true,
});

const widths = [1440, 1180, 1179, 1024, 390, 375];
const observations = [];
const pageErrors = [];

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 812 } });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  // Only the throwaway stack. The backend's explicit index file works even on a build
  // where the root fallback refuses /; no owner data folder or dev server is touched.
  const response = await page.goto('http://127.0.0.1:4300/index.html');
  assert.equal(response?.status(), 200);
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Import' }).click();
  await page.getByRole('heading', { name: 'Import a statement' }).waitFor();

  for (const theme of ['Dark', 'Light']) {
    await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: `${theme} theme` }).click();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 812 });
      const state = await page.evaluate(() => {
        const bounds = (selector) => {
          const { left, top, right, bottom } = document.querySelector(selector).getBoundingClientRect();
          return { left, top, right, bottom };
        };
        const screen = document.querySelector('.screen:not([hidden])');
        const surfaceProbe = document.createElement('span');
        surfaceProbe.style.backgroundColor = 'var(--ink-surface)';
        document.body.append(surfaceProbe);
        const surfaceToken = getComputedStyle(surfaceProbe).backgroundColor;
        surfaceProbe.remove();
        return {
          viewport: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          screenWidth: screen.scrollWidth,
          screenClientWidth: screen.clientWidth,
          columns: getComputedStyle(document.querySelector('.import-layout')).gridTemplateColumns,
          theme: document.documentElement.dataset.theme,
          surfaceToken,
          setupSurface: getComputedStyle(document.querySelector('.import-setup')).backgroundColor,
          guideSurface: getComputedStyle(document.querySelector('.import-guide')).backgroundColor,
          setup: bounds('.import-setup'),
          guide: bounds('.import-guide'),
        };
      });
      assert.equal(state.viewport, width);
      assert.equal(state.theme, theme.toLowerCase());
      assert.equal(state.setupSurface, state.surfaceToken, `${theme} ${width}: setup surface token mismatch`);
      assert.equal(state.guideSurface, state.surfaceToken, `${theme} ${width}: guide surface token mismatch`);
      assert.ok(state.documentWidth <= width, `${theme} ${width}: document overflows`);
      assert.ok(state.screenWidth <= state.screenClientWidth, `${theme} ${width}: screen overflows`);
      assert.ok(state.setup.left >= 0 && state.guide.right <= width, `${theme} ${width}: card offscreen`);
      if (width >= 1180) {
        assert.equal(state.columns.split(' ').length, 2, `${theme} ${width}: expected two columns`);
        assert.ok(Math.abs(state.setup.top - state.guide.top) < 1, `${theme} ${width}: cards not side by side`);
        assert.ok(state.guide.left > state.setup.right, `${theme} ${width}: guide not beside setup`);
      } else {
        assert.equal(state.columns.split(' ').length, 1, `${theme} ${width}: expected one column`);
        assert.ok(state.guide.top >= state.setup.bottom, `${theme} ${width}: guide not after setup`);
      }
      observations.push({ theme, width, columns: state.columns, surfaceToken: state.surfaceToken,
        setupSurface: state.setupSurface, guideSurface: state.guideSurface,
        documentWidth: state.documentWidth, screenWidth: state.screenWidth });
    }
  }
  assert.notEqual(observations[0].surfaceToken, observations[widths.length].surfaceToken,
    'Light and Dark should resolve different surface palette colors');

  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('.import-setup input[type=file]').setInputFiles({
    name: 'layout-check.csv', mimeType: 'text/csv',
    buffer: Buffer.from('0;date;amount;description\n1;01.07.2026;-10,00;LAYOUT CHECK'),
  });
  const newAccount = page.getByRole('button', { name: '+ New account' });
  if (await newAccount.isVisible()) await newAccount.click();
  await page.getByRole('textbox', { name: 'Account name' }).fill('Layout check');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.getByText(/nothing imported yet/).waitFor();
  const staged = await page.evaluate(() => {
    const screen = document.querySelector('.screen:not([hidden])');
    screen.scrollTop = screen.scrollHeight;
    const bounds = (selector) => document.querySelector(selector).getBoundingClientRect();
    return {
      documentWidth: document.documentElement.scrollWidth,
      screenWidth: screen.scrollWidth,
      screenClientWidth: screen.clientWidth,
      resultTop: bounds('.import-results').top,
      resultBottom: bounds('.import-results').bottom,
      guideTop: bounds('.import-guide').top,
      guideBottom: bounds('.import-guide').bottom,
      tabTop: bounds('.tabbar').top,
    };
  });
  assert.ok(staged.documentWidth <= 375 && staged.screenWidth <= staged.screenClientWidth,
    'staged review overflows at 375px');
  assert.ok(staged.resultBottom <= staged.guideTop, 'review does not precede guidance');
  assert.ok(staged.guideBottom < staged.tabTop, 'last content hidden behind tab bar');
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ observations, staged, pageErrors }, null, 2));
} finally {
  await browser.close();
}
