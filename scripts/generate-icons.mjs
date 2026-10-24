import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';

const temporaryRoot = resolve(tmpdir());
const temporary = mkdtempSync(join(temporaryRoot, 'zcode-shift-icons-'));
try {
  execFileSync(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'icon', 'app-icon.svg',
    '--output', temporary], { stdio: 'inherit' });
  mkdirSync('src-tauri/icons', { recursive: true });
  for (const name of ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.ico', 'icon.icns']) {
    copyFileSync(join(temporary, name), join('src-tauri/icons', name));
  }
} finally {
  if (dirname(resolve(temporary)) !== temporaryRoot || !basename(temporary).startsWith('zcode-shift-icons-')) {
    throw Error('Unexpected temporary path; refusing to delete it');
  }
  rmSync(temporary, { recursive: true, force: true });
}
