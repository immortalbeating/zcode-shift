import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
for (const dir of ['src', 'src/locales', 'scripts']) {
  for (const file of readdirSync(dir).filter(file => /\.[cm]?js$/.test(file))) {
    execFileSync(process.execPath, ['--check', join(dir, file)], { stdio: 'inherit' });
  }
}
console.log('PASS JavaScript syntax');
