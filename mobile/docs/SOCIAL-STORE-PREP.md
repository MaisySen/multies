# Next store build: Social prep (from 1.10.6)

1.10.6 is an OTA (JS only). These need a new App Store and Play build, because each adds a native module and the
runtime version is a fingerprint:

- Pick images from Photos for a post. Add `expo-image-picker` (iOS needs NSPhotoLibraryUsageDescription, for example
  "Multies uses your photos when you add one to a post."). Keep the same 1 MB limit and JPEG, PNG, GIF and WebP types
  the server takes (SOCIAL_IMAGE_MAX_BYTES), and shrink larger photos on the phone before sending.
- Optional: a share sheet entry "Post to Multies" from Photos (a share extension).

Until then New post picks an image from Files, as in 1.10.5.
