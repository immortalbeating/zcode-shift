import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { installFixture } from './ui-fixture.mjs';

const output = resolve(process.env.UI_OUTPUT || '.ui-artifacts');
mkdirSync(output, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 5187, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true, args: ['--enable-gpu', '--disable-software-rasterizer',
    ...(process.platform === 'win32' ? ['--use-angle=d3d11'] : [])] });
const report = { input: 'Isolated browser viewport and injected IPC fixtures; no desktop input', captures: [] };
try {
  const cases = [
    ['main-360-zh', 360, 820, 'zh', 'accounts', '/'],
    ['main-520-zh', 520, 820, 'zh', 'accounts', '/'],
    ['main-360-en', 360, 820, 'en', 'accounts', '/'],
    ['running-360-zh', 360, 800, 'zh', 'running', '/'],
    ['empty-360-zh', 360, 640, 'zh', 'empty', '/'],
    ['error-360-zh', 360, 820, 'zh', 'error', '/'],
    ['loading-360-zh', 360, 820, 'zh', 'loading', '/'],
    ['settings-360-zh', 360, 720, 'zh', 'accounts', '/settings.html'],
    ['settings-520-zh', 520, 760, 'zh', 'accounts', '/settings.html'],
    ['settings-360-en', 360, 820, 'en', 'accounts', '/settings.html'],
    ['scheduled-360-zh', 360, 820, 'zh', 'scheduled', '/'],
    ['scheduled-360-en', 360, 820, 'en', 'scheduled', '/'],
    ['global-active-360-zh', 360, 820, 'zh', 'global-active', '/'],
  ];
  for (const [name, width, height, language, scenario, path] of cases) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1,
      reducedMotion: 'reduce', timezoneId: 'Asia/Shanghai' });
    await context.addInitScript(installFixture, { language, scenario });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:5187${path}`);
    await page.locator('.wordmark').waitFor();
    if (scenario !== 'empty' && path === '/') {
      await page.locator('.row').first().waitFor();
      await page.evaluate(() => {
        for (const id of ['demo-primary', 'demo-secondary', 'demo-long-name']) window.actions.acctQuota(id);
      });
      if (scenario !== 'loading') {
        await page.locator(`.row[data-id="demo-primary"] ${scenario === 'scheduled' ? '.scheduled-grant' : '.q-win'}`).first().waitFor();
        await page.locator('.row[data-id="demo-long-name"] .q-win').first().waitFor();
      }
    }
    await page.locator('#splash').waitFor({ state: 'detached' });
    const inspection = await page.evaluate(() => {
      const canvas = document.createElement('canvas'), gl = canvas.getContext('webgl');
      const debug = gl?.getExtension('WEBGL_debug_renderer_info');
      return { overflow: document.documentElement.scrollWidth > innerWidth,
        renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
        rows: document.querySelectorAll('.row').length,
        brand: document.querySelector('.wordmark').textContent };
    });
    assert.equal(inspection.overflow, false, `${name} overflows`);
    assert.ok(inspection.renderer && !/SwiftShader|llvmpipe|software/i.test(inspection.renderer),
      `GPU renderer required, received ${inspection.renderer}`);
    assert.deepEqual(errors, [], name);
    if (['scheduled', 'global-active'].includes(scenario)) {
      const row = page.locator('.row[data-id="demo-primary"]');
      assert.equal(await row.getByText('ZCODE GLOBAL BUILD', { exact: true }).count(), 1);
      if (scenario === 'scheduled') {
        assert.equal(await row.locator('.qbar').count(), 0, 'future grants must not look spendable');
        assert.match(await row.locator('.sg-amount').innerText(), language === 'zh' ? /3亿/ : /300M/);
        assert.match(await row.locator('.sg-status').innerText(), /23:00/);
        assert.match(await row.locator('.row-meta').innerText(), /2026-10-27 09:00/);
        const mixed = page.locator('.row[data-id="demo-secondary"]');
        assert.equal(await mixed.locator('.plan-grp').count(), 2, 'existing and future plans stay separate');
        assert.equal(await mixed.locator('.qbar').count(), 2, 'future grant adds no spendable bar');
        assert.equal(await mixed.locator('.scheduled-grant').count(), 1);
      } else {
        assert.equal(await row.locator('.scheduled-grant').count(), 0);
        assert.match(await row.locator('.q-win-reset').innerText(), /3亿\/3亿/);
      }
    }
    if (path === '/') {
      const buttons = await page.locator('.compact-toolbar button').evaluateAll(buttons =>
        buttons.map(button => ({ top: button.getBoundingClientRect().top,
          label: button.getAttribute('aria-label'), tip: button.dataset.tip })));
      assert.ok(buttons.every(button => button.label && button.tip), `${name}: unnamed toolbar action`);
      assert.ok(Math.max(...buttons.map(button => button.top)) - Math.min(...buttons.map(button => button.top)) <= 1,
        `${name}: toolbar must stay on one row`);
    }
    await page.screenshot({ path: resolve(output, `${name}.png`) });
    if (name === 'main-360-zh') {
      const row = page.locator('.row').first();
      const refresh = row.getByRole('button', { name: '查额度', exact: true });
      await refresh.hover();
      await page.getByRole('tooltip').filter({ hasText: '查额度' }).waitFor();
      await page.screenshot({ path: resolve(output, 'account-actions-hover.png') });
      await page.keyboard.press('Escape');
      const topRefresh = page.getByRole('button', { name: '刷新资格', exact: true });
      await topRefresh.focus();
      await page.getByRole('tooltip').waitFor();
      const tipBox = await page.getByRole('tooltip').boundingBox();
      assert.ok(tipBox.x >= 0 && tipBox.x + tipBox.width <= width, 'tooltip must stay inside narrow viewport');
      await page.screenshot({ path: resolve(output, 'toolbar-focus-tooltip.png') });
      await page.keyboard.press('Escape');
      await page.getByRole('tooltip').waitFor({ state: 'detached' });
      assert.equal(await row.locator('.row-actions svg[viewBox="0 0 24 24"]').count(), 4,
        'all account actions use AGY outline icons');
      await row.getByRole('button', { name: '重命名', exact: true }).click();
      await page.locator('.rename-input').fill('合成账号重命名');
      await page.locator('.rename-input').press('Enter');
      await page.getByText('合成账号重命名', { exact: true }).waitFor();
      assert.equal(await page.locator('.row').count(), 3);
      await page.keyboard.press('Tab');
      assert.ok(await page.evaluate(() => document.activeElement !== document.body));
    }
    if (name === 'settings-360-zh') {
      await page.getByRole('radio', { name: 'English', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.lang-opt[aria-checked="true"]')?.textContent.trim() === 'English');
      assert.equal(await page.getByRole('radio', { name: 'English', exact: true }).getAttribute('aria-checked'), 'true');
      const proxy = page.locator('input.auth-proxy');
      await proxy.scrollIntoViewIfNeeded();
      assert.ok((await proxy.boundingBox()).width <= width - 24);
    }
    report.captures.push({ name, width, height, language, scenario, ...inspection });
    await context.close();
  }
  report.status = 'PASS';
} finally {
  await browser.close();
  await server.close();
  writeFileSync(resolve(output, 'ui-validation.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(`PASS: ${report.captures.length} GPU-rendered fixture captures; output ${output}`);
