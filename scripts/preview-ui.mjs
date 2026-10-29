// Deliberately separate from the app's dev/build entry: synthetic accounts only.
import { createServer } from 'vite';
import { installFixture } from './ui-fixture.mjs';

const fixture = `(${installFixture.toString()})({scenario:'workbench',language:'zh'});`;
const server = await createServer({
  server: { host: '127.0.0.1', port: 5188, strictPort: true },
  plugins: [{ name: 'synthetic-ui-preview', transformIndexHtml: {
    order: 'pre', handler(html) { return html.replace('<head>', `<head><script>${fixture}</script>`); },
  } }],
});
await server.listen();
console.log('Synthetic UI preview: http://127.0.0.1:5188/');
