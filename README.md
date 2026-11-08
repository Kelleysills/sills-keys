# Sills Licence Manager (phone)

An installable web app (PWA) for issuing and managing Sills Audio licence keys from a phone.

- Holds ONE admin pass (god-mode pass made on the PC: Hub > Licence manager > Admins), encrypted on the phone with a
  PIN (PBKDF2-SHA256 310k + AES-GCM). The master signing key never leaves the PC.
- Issue keys (in the pass's scope, serials in the pass's own admin range), look them up, re-issue (upgrade /
  downgrade: the old key is marked "replaced"; revoke it on the PC), check any key, see revocation status (reads the
  signed revoked.txt from the releases repo).
- Import the PC's issued-keys.csv to look up / re-issue every key; export the phone's keys as CSV for the PC.
- core.js mirrors Source/Common/License.cpp byte for byte (WebCrypto Ed25519). Keep product bits / suitesOf in sync.
- Needs HTTPS (WebCrypto + service worker): host the folder as static files (GitHub Pages, Cloudflare Pages...).
  No secrets in these files.
- Revoking keys still needs the master key: do it on the PC.
