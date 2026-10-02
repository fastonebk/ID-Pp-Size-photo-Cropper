# ID photo cropper

Open `index.html` in Chrome, Edge, Firefox or Safari (or serve the folder with `python3 -m http.server`).

- Add one or many photos. Each is auto-cropped to 300 x 378 px (1 x 1.26 in, 300 DPI) and exported as JPG with the original filename.
- Click **Edit** on a card to zoom, move, reset, auto-center, and save, with a safe-area guide.
- **Download all as ZIP** bundles every cropped photo.

Face detection uses face-api.js (tiny face detector + 68 landmarks), loaded from the jsDelivr CDN, so the first run needs internet. Photos are processed in your browser and never uploaded.
Without the detector, photos get a default centred crop that you can fix in the editor.

Files: index.html, style.css, app.js
