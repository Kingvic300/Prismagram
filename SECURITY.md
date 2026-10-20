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
| Schema privacy | Schemas are parsed and drawn locally. The app makes no network requests. |
| Untrusted schema files | The parser never executes schema content; all text is escaped before it reaches the SVG or the editor. |
| File access | The webview can only read and write files through four narrow commands (read/write text, write image, modification time), and only for paths the user picked in a dialog, dropped, or passed on the command line. |
| Tauri permissions | The window has `core:default`, `dialog:default` and permission to set its title. Nothing else. |

## Known limitations

- Installers are not code-signed yet. Verify downloads against the `SHA256SUMS` file
  attached to each release.
