# screenbeam

Transfer files between devices with animated barcodes. One screen, one camera, zero network.

Two things set it apart.

First, it is just HTML and JavaScript. The sender and the receiver are two standalone HTML files. No install, no server, no build step, no WASM. They work from a USB stick or an email attachment, even on locked-down machines where you cannot install anything. View source and every line is readable.

Second, jsColorGrid: a custom 4-color barcode format built for this project and implemented from scratch, covering QR-style finder patterns, perspective correction, per-frame color calibration, Reed-Solomon error correction, and LT fountain coding in dependency-free JavaScript. As far as we know, it is the first color screen-to-camera decoder written in pure browser JS. On the same phone camera, it moved files about 3x faster than QR mode.

## How it works

1. Open `sender.html` on any device with a screen. Pick a file.
2. Open `receiver.html` on any device with a camera. Pick the matching mode and tap "Start Camera."
3. Point the camera at the stream. The file reconstructs and downloads.

The sender does not know the receiver exists. There is no pairing and no handshake.

### Fountain codes

Dropped frames do not matter. Each frame encodes an XOR of a pseudorandom subset of the file's blocks using a robust-soliton distribution (Luby transform). The receiver needs roughly K x 1.15 distinct frames in any order to reconstruct the file. Miss a frame and it takes slightly longer. There is no retransmission and no back-channel.

### jsColorGrid mode

Every cell carries 2 bits using 4 colors: black, white, red, cyan. Three QR-style finder patterns and an alignment pattern let the receiver correct for perspective. Each frame carries interleaved Reed-Solomon blocks, so a sprinkle of misread cells gets corrected instead of killing the frame, and a checksum drops anything worse. The receiver re-measures what the four colors look like through your camera on every frame, which is how it copes with cheap cameras that shift and smear colors.

QR mode uses jsQR and the qrcode package, the only third-party code in the project. jsColorGrid mode runs entirely on code written for this repo.

### Throughput

Measured on a mid-range phone camera: jsColorGrid at grid 80 / 15 FPS moves about 9 KB/s. QR mode peaks around 3 KB/s on the same setup. Keep TX FPS at about half your camera's capture rate (default 15 for a 30 FPS camera). Pushing FPS higher backfires: the camera catches frames mid-transition and the receiver skips them.

## Deployment

### Sender

The sender has no restrictions. It works from `file://`, USB drives, email attachments. Open the HTML in any browser on any OS and the stream starts as soon as you pick a file.

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
    sender.html        works from file://
    receiver.html      needs secure context for camera
  docs/                GitHub Pages (same files + landing page)
  src/
    shared/
      protocol.js      Frame protocol, 20-byte header, FNV-1a, splitmix32
      fountain.js      LT fountain codes, encoder, decoder
      colorgrid.js     jsColorGrid: finder detection, perspective
                       sampling, per-frame color calibration, checksum
      rs.js            Reed-Solomon over GF(256) for jsColorGrid frames
    sender/            Sender source (uses qrcode for QR mode)
    receiver/          Receiver source (uses jsQR for QR mode)
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

- Mode: QR (B&W) or jsColorGrid (4-color)
- TX FPS: 10-60 (default 15)
- Grid size: 48-96 (jsColorGrid only, default 64)
- Bytes per frame and error correction (QR mode only)
- Display size: 300-1200px

Receiver (set before starting camera):

- Mode: must match the sender
- Capture width: 960/1280/1920 (default 1280)
- Capture FPS: 30/60 (default 60)

## License

screenbeam's own code is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md): use it, modify it, share it freely for any noncommercial purpose. For commercial licensing, open an issue.

Bundled third-party components keep their own licenses: jsQR (Apache 2.0) and qrcode (MIT), both used only by QR mode.
