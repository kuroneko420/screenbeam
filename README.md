# screenbeam

Transfer files between devices using fountain-coded animated QR codes. One screen, one camera, zero network.

The sender is a single 88 KB HTML file. Double-click it, pick a file, done. The receiver is 375 KB because it bundles a QR decoder. Two files, no install, no server.

Inspired by [decimen-optical-transfer](https://github.com/bashalarmistalt/decimen-optical-transfer), which needs a full Node.js + Vite + TypeScript + WASM toolchain running before anything happens. screenbeam compiles all of that down to two HTML files you can throw on a USB stick.

## How it works

1. Open `sender.html` on any device with a screen. Pick a file.
2. Open `receiver.html` on any device with a camera. Tap "Start Camera."
3. Point the camera at the QR stream. The file reconstructs and downloads.

The sender does not know the receiver exists. There is no pairing and no handshake.

### Fountain codes

Dropped frames do not matter. Each QR frame encodes an XOR of a pseudorandom subset of the file's blocks using a robust-soliton distribution (Luby transform). The receiver needs roughly K x 1.15 distinct frames in any order to reconstruct the file. Miss a frame and it takes slightly longer. There is no retransmission and no back-channel.

### Throughput

QR Version 27 at 24 FPS gives about 28 KB/s. A 512 KB file takes roughly 10-25 seconds depending on camera quality, lighting, and distance. You can push it to V40 / 30 FPS for denser codes at close range, though that needs a steady phone and good lighting.

## Deployment

### Sender

The sender has no restrictions. It works from `file://`, USB drives, email attachments. Open the HTML in any browser on any OS and the QR stream starts as soon as you pick a file.

### Receiver (HTTPS caveat)

Camera access (`getUserMedia`) requires a secure context on modern browsers:

- `https://` works everywhere. Hosted version at [kuroneko420.github.io/screenbeam](https://kuroneko420.github.io/screenbeam/)
- `localhost` works for local testing
- `file://` on desktop works on Chrome, Firefox, Edge
- `file://` on Android does not work. Android browsers deny camera access from local files.

For airgapped systems where the receiver has no internet:

- Pre-load the hosted receiver page while you still have connectivity. It works offline once loaded.
- Copy `receiver.html` to the phone over USB or Bluetooth beforehand, then serve it from a local HTTPS server.
- Use a desktop or laptop as the receiver instead. `file://` works on desktop browsers.

## Project structure

```
screenbeam/
  dist/
    sender.html        81 KB, works from file://
    receiver.html     355 KB, needs secure context for camera
  docs/                GitHub Pages (same files + landing page)
  src/
    shared/
      protocol.js      Frame protocol, 20-byte header, FNV-1a, splitmix32
      fountain.js      LT fountain codes, encoder, decoder
      colorgrid.js     4-color grid mode: finder detection, perspective
                       sampling, per-frame calibration, frame checksum
      rs.js            Reed-Solomon over GF(256) for color frames
    sender/            Sender source (uses qrcode)
    receiver/          Receiver source (uses jsQR)
  build.js             Bundles src/ into standalone HTML via esbuild
  send-file.vbs        Power Automate Desktop helper for locked-down environments
```

## Building from source

Only needed if you want to modify the code. Otherwise grab the HTML files from `dist/` or the [releases page](https://github.com/kuroneko420/screenbeam/releases).

```bash
npm install
npm run build
```

Output goes to `dist/` and `docs/`.

## Settings

Sender (adjustable in the Settings panel):

- TX FPS: 10-60 (default 24)
- Bytes per frame: 500-2953 (default 1465, QR V27)
- Error correction: L/M/Q/H (default L, the fountain layer already handles dropped frames)
- Display size: 300-1200px

Receiver (set before starting camera):

- Capture width: 960/1280/1920 (default 1280)
- Capture FPS: 30/60 (default 60)

## License

MIT
