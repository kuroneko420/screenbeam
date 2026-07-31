import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs';

async function bundle(entry, minify = false) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    write: false,
    minify,
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

  // The decode worker is bundled separately and embedded into the main
  // receiver bundle as base64; the receiver spawns it from a Blob URL so
  // the page stays a single self-contained file.
  const workerJs = await bundle('src/receiver/worker.js');
  const workerB64 = Buffer.from(workerJs).toString('base64');
  const receiverJs = (await bundle('src/receiver/main.js')).replace('__WORKER_B64__', workerB64);
  const receiverHtml = readFileSync('src/receiver/index.html', 'utf8');
  writeFileSync(
    'dist/receiver.html',
    receiverHtml.replace('<!-- BUNDLE -->', '<script>' + receiverJs + '<' + '/script>')
  );

  // Minified variants: same pages, smallest possible files. The regular
  // builds stay unminified so view-source stays readable.
  const senderJsMin = await bundle('src/sender/main.js', true);
  writeFileSync(
    'dist/sender.min.html',
    senderHtml.replace('<!-- BUNDLE -->', '<script>' + senderJsMin + '<' + '/script>')
  );
  const workerJsMin = await bundle('src/receiver/worker.js', true);
  const workerB64Min = Buffer.from(workerJsMin).toString('base64');
  const receiverJsMin = (await bundle('src/receiver/main.js', true)).replace('__WORKER_B64__', workerB64Min);
  writeFileSync(
    'dist/receiver.min.html',
    receiverHtml.replace('<!-- BUNDLE -->', '<script>' + receiverJsMin + '<' + '/script>')
  );

  copyFileSync('dist/sender.html', 'docs/sender.html');
  copyFileSync('dist/receiver.html', 'docs/receiver.html');

  for (const f of ['sender.html', 'receiver.html', 'sender.min.html', 'receiver.min.html']) {
    const kb = (Buffer.byteLength(readFileSync('dist/' + f)) / 1024).toFixed(0);
    console.log(('dist/' + f).padEnd(23) + '(' + kb + ' KB)');
  }
  console.log('docs/ synced');
}

main().catch(err => { console.error(err); process.exit(1); });
