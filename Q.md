-------------- GUIDELINES ----------------
1. After every task, you must build the scripts and sync it to ~/.Q via pnpm build
2. Whenever writing visual descriptions or text on the TUI or docstrings, you are to never use icons like check mark, rocket ship, satellite, etc. It must be done through proficient, professional, Text augmentation and GIFs. Never Icons

-------------- QSSH CONVENTIONS ----------------
3. Remote credentials are encrypted with AES-256-GCM and a per-session passphrase. Never write passphrases or decrypted credentials to disk in plaintext.
4. Local Ollama instances (localhost / 127.0.0.1 base URLs) must be rejected for remote execution — the cloud cannot reach them.
5. The remote daemon must use a file-based control channel (control.jsonl), not stdin, so it survives nohup without an open stdin.
6. All loading animations, progress bars, and banners in the SSH connect flow must use text augmentation and ASCII box-drawing characters only — no icons.
7. Bi-directional sync must use a manifest-based differential approach with a 3-way merge baseline. Never overwrite files without comparing sha256 hashes first.
8. After building q-remote, run `pnpm build:remote` to produce the tarball in dist-packs/ and sync it to ~/.Q/build/.