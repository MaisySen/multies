# Third party notices

Multies includes open source software. This file lists the licences that ask to be reproduced.

## Phosphor Icons (@phosphor-icons/react)

Every icon in the web app (src/web/components/ui/icon.tsx) and the iOS app is drawn from Phosphor Icons.
https://phosphoricons.com

```
MIT License

Copyright (c) 2020 Phosphor Icons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## react-resizable-panels

The resizable sidebar, Mail reading pane and task details panel (src/web/layouts/app.tsx, src/web/pages/app/webmail.tsx).
https://github.com/bvaughn/react-resizable-panels

```
The MIT License (MIT)

Copyright (c) 2018 Brian Vaughn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Lucide (lucide-react)

Kept in package.json only until every branch has moved to the Icon component (R35); no web code imports it.
ISC licence, https://lucide.dev/license.

## Dancing Script, Great Vibes, Caveat (e-sign signature fonts)

Tools P2: three script fonts for typed signatures, subset to Latin and converted to WOFF2 in public/fonts/sign/.
SIL Open Font License 1.1; copyright lines and the full licence are in public/fonts/sign/OFL.txt.

## Convert hub (src/web/lib/convert)

The Convert hub in Tools converts images, PDFs and spreadsheets in the browser with these libraries. They load only on the Tools page.

MIT License:

- pdf-lib, Copyright (c) 2019 Andrew Dillon
- @pdf-lib/standard-fonts, Copyright (c) 2018 Andrew Dillon
- @pdf-lib/upng, Copyright (c) 2017 Photopea
- gifenc, Copyright (c) 2017 Matt DesLauriers
- write-excel-file and read-excel-file, Copyright (c) 2018 catamphetamine
- fflate, Copyright (c) Arjun Barrett
- papaparse, Copyright (c) 2015 Matthew Holt
- pako (MIT and Zlib), Copyright (C) 2014-2017 Vitaly Puzrin and Andrei Tuputcyn

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE
OR OTHER DEALINGS IN THE SOFTWARE.
```

Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0):

- pdfjs-dist (PDF.js), Copyright Mozilla Foundation
- @jsquash/avif and @jsquash/webp, Copyright jSquash contributors, built from the Squoosh codecs (Copyright Google LLC)

The AVIF and WebP encoders compiled into those packages are libavif and libaom (BSD 2 Clause, Copyright Joe Drago and the Alliance for Open Media) and libwebp (BSD 3 Clause, Copyright Google Inc.). Their licence texts ship in the packages' wasm builds and are reproduced at https://github.com/AOMediaCodec/libavif/blob/main/LICENSE, https://aomedia.googlesource.com/aom/+/refs/heads/main/LICENSE and https://chromium.googlesource.com/webm/libwebp/+/refs/heads/main/COPYING.

## Archive reader (public/vendor/libarchive, src/web/lib/convert/vendor) (R86)

libarchive.js 2.0.2, MIT License, Copyright (c) 2018 Nika Begiashvili. Used unchanged to open ZIP, 7Z, TAR,
TAR.GZ and RAR archives in the browser (read only; Multies writes ZIP with fflate and TAR itself).

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice
and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS
PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

The WebAssembly module inside it is built from:
- libarchive, BSD 2 Clause License, Copyright (c) 2003 to 2023 Tim Kientzle and the libarchive contributors
  (its RAR and 7Z readers are its own BSD code).
- zlib, zlib License, Copyright (c) 1995 to 2024 Jean-loup Gailly and Mark Adler.
- bzip2, BSD style License, Copyright (c) 1996 to 2019 Julian R Seward.
- liblzma (XZ Utils), public domain and 0BSD.
- OpenSSL, Apache License 2.0 (hashing only).
- comlink, Apache License 2.0, Copyright 2019 Google LLC (bundled in the main module and the worker).

## Multies engine: video, audio, HEIC photos and e-books (R86)

Run on the Multies document engine server, not in the browser: FFmpeg 8.1 in its LGPL 2.1 build (no GPL or nonfree
parts; the build checks this), run as a separate program, the same way the engine runs LibreOffice (MPL 2.0). Its
source and licence are listed in the engine's own NOTICE. The EPUB and MOBI readers are Multies' own code.

## Integration platform (Composio)

Settings, Connections and Social posts reach outside apps through Composio (https://composio.dev), a hosted service: the
sign in for each connected account happens on its pages and its tokens stay with it. Multies calls its REST API from the
server only and ships none of its code. App names and logos in the gallery belong to their owners.
