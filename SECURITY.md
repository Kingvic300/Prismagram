# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Use GitHub's private vulnerability reporting ("Security" tab → "Report a vulnerability")
on this repository. Include the affected version, reproduction steps and impact. We aim to
acknowledge reports within 5 working days and to publish a fix within 90 days, crediting
you unless you prefer otherwise.

Only the latest release receives security fixes.

## Design

Prismagram is a single-user desktop application with no server component.

| Concern | Mitigation |
| --- | --- |
| Schema privacy | Schemas are parsed and drawn locally and never sent anywhere. |
| Updates | The update check is a download of `latest.json` from GitHub Releases. Update packages are signed, and the app verifies them against the public key built into it before installing. |
| Database import | Only when the user clicks **Import**, the app connects to the database they entered and runs one read-only query on `pg_catalog`: no table rows are read and nothing is written. The password is never stored; the remembered connection string has it replaced by `[YOUR-PASSWORD]`. The connection uses TLS (required for Supabase hosts) without certificate verification by default, like libpq's `sslmode=require`, because Supabase uses a private CA; `sslmode=verify-full` with `sslrootcert` verifies it. |
| Saved connections (Data mode) | The connection string and password of each saved connection are stored in the operating system's keychain (Keychain on macOS, Credential Manager on Windows, Secret Service such as GNOME Keyring or KWallet on Linux), which encrypts them and unlocks them with the user's login. The app's own storage keeps only the name, the database kind and the connection string with the password replaced by `[YOUR-PASSWORD]`. **Clear all data** and **Forget** remove the keychain entries. Without a keychain, nothing is saved and the password is asked for again. |
| Untrusted schema files | The parser never executes schema content; all text is escaped before it reaches the SVG or the editor. |
| File access | The webview can only read and write files through four narrow commands (read/write text, write image, modification time), and only for paths the user picked in a dialog, dropped, or passed on the command line. |
| Tauri permissions | The window has `core:default`, `dialog:default`, `updater:default`, `process:allow-restart` and permission to set its title. Nothing else. |

## Known limitations

- Installers are not code-signed yet. Verify downloads against the `SHA256SUMS` file
  attached to each release.
