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
    ['settings-full-360-zh', 360, 1240, 'zh', 'accounts', '/settings.html'],
    ['settings-long-360-en', 360, 720, 'en', 'long-settings', '/settings.html'],
    ['settings-hidpi-360-zh', 360, 720, 'zh', 'accounts', '/settings.html', 2],
    ['scheduled-360-zh', 360, 820, 'zh', 'scheduled', '/'],
    ['scheduled-360-en', 360, 820, 'en', 'scheduled', '/'],
    ['global-active-360-zh', 360, 820, 'zh', 'global-active', '/'],
  ];
  for (const [name, width, height, language, scenario, path, scale = 1] of cases) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale,
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
    if (path === '/settings.html') {
      assert.deepEqual(await page.locator('.settings-group').evaluateAll(groups => groups.map(group => group.dataset.group)),
        ['general', 'switch', 'network', 'library', 'about']);
      const repository = page.locator('.settings-repo');
      assert.equal(await repository.getAttribute('href'), 'https://github.com/immortalbeating/zcode-shift');
      assert.equal((await repository.innerText()).trim(), 'immortalbeating/zcode-shift');
      assert.doesNotMatch(await page.locator('.settings').innerText(), /pjpv|zcode.switch|superidiot1201/i);
      assert.equal(await page.getByRole('switch').count(), 5, 'all settings switches remain available');
      const inputNames = await page.locator('.settings input').evaluateAll(inputs => inputs.map(input =>
        document.querySelector(`label[for="${input.id}"]`)?.textContent.trim()));
      assert.ok(inputNames.every(Boolean), 'path and proxy fields need visible labels');
      assert.equal(await page.locator('.settings-detail[open]').count(), 0, 'long notes are collapsed by default');
    }
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
      const repository = page.locator('.settings-repo');
      await repository.click();
      await page.waitForFunction(() => window.__fixtureCalls.some(call => call.command === 'open_external'));
      const external = await page.evaluate(() => window.__fixtureCalls.filter(call => call.command === 'open_external'));
      assert.deepEqual(external.map(call => call.args.url), ['https://github.com/immortalbeating/zcode-shift']);
      assert.equal(context.pages().length, 1, 'repository click uses native IPC only');

      for (const [action, checked] of [['actions.toggleAutostart()', true], ["actions.toggleBehavior('tray')", false],
        ["actions.toggleBehavior('launch')", false], ["actions.toggleBehavior('hot')", false], ['actions.toggleAuthProxy()', true]]) {
        await page.locator(`button[click="${action}"]`).click();
        await page.waitForFunction(({action, checked}) => [...document.querySelectorAll('button[click]')]
          .find(button => button.getAttribute('click') === action)?.getAttribute('aria-checked') === String(checked), {action, checked});
      }
      await page.locator('[data-note="hot"] summary').click();
      await page.locator('[data-note="proxy"] summary').click();
      const proxy = page.getByLabel('代理地址', { exact: true });
      await proxy.fill('http://127.0.0.1:7890');
      await page.getByRole('button', { name: '保存代理地址', exact: true }).click();
      await page.waitForFunction(() => window.__fixtureCalls.some(call => call.command === 'set_auth_proxy'
        && call.args.on === true && call.args.url === 'http://127.0.0.1:7890'));
      assert.equal(await page.locator('.settings-detail[open]').count(), 2, 'expanded notes survive a settings refresh');
      const pathInput = page.getByLabel('ZCode 程序路径', { exact: true });
      const samplePath = 'C:\\Apps\\ZCode\\ZCode.exe';
      await pathInput.fill(samplePath);
      await page.getByRole('button', { name: '保存程序路径', exact: true }).click();
      await page.waitForFunction(path => window.__fixtureCalls.some(call => call.command === 'set_zcode_path'
        && call.args.path === path), samplePath);
      for (const [label, command] of [['浏览', 'pick_zcode_path'], ['导入账号文件', 'import_pick_files'], ['导出全部（加密）', 'export_all_pick_path']]) {
        await page.getByRole('button', { name: label, exact: true }).click();
        await page.waitForFunction(command => window.__fixtureCalls.some(call => call.command === command), command);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.getByRole('radio', { name: 'English', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.lang-opt[aria-checked="true"]')?.textContent.trim() === 'English');
      assert.equal(await page.getByRole('radio', { name: 'English', exact: true }).getAttribute('aria-checked'), 'true');
      const localizedProxy = page.locator('#auth-proxy');
      await localizedProxy.scrollIntoViewIfNeeded();
      assert.ok((await localizedProxy.boundingBox()).width <= width - 24);
    }
    if (name === 'settings-long-360-en') {
      for (const summary of await page.locator('.settings-detail summary').all()) await summary.click();
      await page.locator('#zcode-path').focus();
      await page.locator('#zcode-path').press('End');
      assert.ok((await page.locator('#zcode-path').inputValue()).length > 300);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), 'Browse');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.locator('.settings-about').scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(output, 'settings-long-expanded-bottom.png') });
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
