# screenbeam

Transfer files between devices using fountain-coded animated QR codes. One screen, one camera, zero network.

**The entire sender is a single 81 KB HTML file.** No install, no server, no dependencies, no build step for the end user. Double-click it, pick a file, done. The receiver is 355 KB (includes an inlined QR decoder) and works the same way. Two files. That's the whole thing.

Inspired by [decimen-optical-transfer](https://github.com/bashalarmistalt/decimen-optical-transfer), which requires Node.js, npm, Vite, TypeScript compilation, a WASM blob, and a dev server before it does anything. screenbeam strips all of that away: the output is two standalone HTML files that run anywhere a browser exists.

## How it works

1. Open `sender.html` on any device with a screen. Pick a file.
2. Open `receiver.html` on any device with a camera. Tap "Start Camera."
3. Point the camera at the QR stream. The file reconstructs itself and downloads.

No pairing, no handshake, no network whatsoever. The sender doesn't even know the receiver exists.

### Fountain codes

Dropped frames don't matter. Each QR frame encodes an XOR of a pseudorandom subset of the file's blocks, drawn from a robust-soliton distribution (Luby transform). The receiver needs roughly K x 1.15 distinct frames in any order to reconstruct the file. Miss a frame? It just takes slightly longer. No retransmission, no back-channel, no sequence dependencies.

### Throughput

QR Version 27 at 24 FPS gives ~28 KB/s effective throughput. A 512 KB file transfers in roughly 10-25 seconds depending on camera quality, lighting, and distance. Configurable: bump to V40 / 30 FPS for denser encoding at close range.

## Deployment

### Sender (the easy part)

The sender needs no server. It works from `file://`, USB drives, email attachments, wherever. Open the HTML file in any browser on any OS, pick a file, QR codes start streaming. Works on laptops, desktops, tablets, phones, anything with a screen and a browser.

### Receiver (the HTTPS caveat)

Camera access (`getUserMedia`) requires a **secure context** on modern browsers. This means:

- **HTTPS**: works everywhere (hosted version at [kuroneko420.github.io/screenbeam](https://kuroneko420.github.io/screenbeam/))
- **localhost**: works (for local development/testing)
- **file://** on desktop: works on most desktop browsers (Chrome, Firefox, Edge treat local files as secure)
- **file:// on Android**: does **not** work. Android Chrome and Edge deny camera access from local files.

For actual airgapped systems where the receiver device has no internet to load the hosted version, you have options:
- Pre-load the receiver page while you still have connectivity (it's fully self-contained, works offline after loading)
- Transfer `receiver.html` to the phone via USB/Bluetooth/SD card beforehand, then serve it locally
- Use a desktop/laptop as the receiver instead (file:// works on desktop browsers)
- Run a local HTTPS server on the receiving device if you know how

The sender side has no restrictions at all. It's just rendering canvas pixels.

## Project structure

```
screenbeam/
  dist/
    sender.html        81 KB, self-contained, works from file://
    receiver.html     355 KB, self-contained, needs secure context for camera
  docs/                GitHub Pages deployment (same files + landing page)
  src/
    shared/
      protocol.js      Frame protocol: 20-byte header, FNV-1a hash, splitmix32 PRNG
      fountain.js      LT fountain codes: encoder, decoder, robust-soliton distribution
    sender/            Sender page source (uses qrcode npm package)
    receiver/          Receiver page source (uses jsQR npm package)
  build.js             Bundles src/ into self-contained HTML via esbuild
  send-file.vbs        Optional Power Automate Desktop helper
```

## Building from source

Only needed if you want to modify the code. End users just grab the two HTML files from `dist/`.

```bash
npm install
npm run build
```

Produces `dist/sender.html` and `dist/receiver.html`. Also syncs to `docs/` for GitHub Pages.

## Settings

**Sender** (adjustable via the Settings panel):
- TX FPS: 10-30 (default 24)
- Bytes per frame: 500-2953 (default 1465, QR V27)
- Error correction: L/M/Q/H (default L; fountain layer handles erasures)
- Display size: 300-1200px

**Receiver** (set before starting camera):
- Capture width: 960/1280/1920 (default 1280)
- Capture FPS: 30/60 (default 60)

## License

MIT
