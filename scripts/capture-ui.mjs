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
    ['empty-360-zh', 360, 640, 'zh', 'empty', '/'],
    ['error-360-zh', 360, 820, 'zh', 'error', '/'],
    ['loading-360-zh', 360, 820, 'zh', 'loading', '/'],
    ['settings-520-zh', 520, 760, 'zh', 'accounts', '/settings.html'],
    ['settings-360-en', 360, 820, 'en', 'accounts', '/settings.html'],
  ];
  for (const [name, width, height, language, scenario, path] of cases) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1,
      reducedMotion: 'reduce' });
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
        await page.locator('.row[data-id="demo-primary"] .q-win').first().waitFor();
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
    await page.screenshot({ path: resolve(output, `${name}.png`) });
    if (name === 'main-360-zh') {
      const row = page.locator('.row').first();
      await row.getByRole('button', { name: '重命名', exact: true }).click();
      await page.locator('.rename-input').fill('合成账号重命名');
      await page.locator('.rename-input').press('Enter');
      await page.getByText('合成账号重命名', { exact: true }).waitFor();
      assert.equal(await page.locator('.row').count(), 3);
      await page.keyboard.press('Tab');
      assert.ok(await page.evaluate(() => document.activeElement !== document.body));
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
