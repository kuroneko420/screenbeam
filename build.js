import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs';

async function bundle(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    write: false,
    minify: false,
    target: 'es2020',
    platform: 'browser',
  });
  return result.outputFiles[0].text;
}

async function main() {
  mkdirSync('dist', { recursive: true });
  mkdirSync('docs', { recursive: true });

  const senderJs = await bundle('src/sender/main.js');
  const senderHtml = readFileSync('src/sender/index.html', 'utf8');
  writeFileSync(
    'dist/sender.html',
    senderHtml.replace('<!-- BUNDLE -->', '<script>' + senderJs + '<' + '/script>')
  );

  const receiverJs = await bundle('src/receiver/main.js');
  const receiverHtml = readFileSync('src/receiver/index.html', 'utf8');
  writeFileSync(
    'dist/receiver.html',
    receiverHtml.replace('<!-- BUNDLE -->', '<script>' + receiverJs + '<' + '/script>')
  );

  copyFileSync('dist/sender.html', 'docs/sender.html');
  copyFileSync('dist/receiver.html', 'docs/receiver.html');

  const senderSize = (Buffer.byteLength(readFileSync('dist/sender.html')) / 1024).toFixed(0);
  const receiverSize = (Buffer.byteLength(readFileSync('dist/receiver.html')) / 1024).toFixed(0);
  console.log('dist/sender.html   (' + senderSize + ' KB)');
  console.log('dist/receiver.html (' + receiverSize + ' KB)');
  console.log('docs/ synced');
}

main().catch(err => { console.error(err); process.exit(1); });
