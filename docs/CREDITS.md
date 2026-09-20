# Credits

**Project maintainer:** [Kieran Schmitt](https://github.com/KieranCSchmitt).

**Development assistance:** OpenAI Codex assisted with code, tests, debugging and documentation.

## Artwork and typography

The Eve mark and interface artwork are part of the project's visual identity. Inter and Newsreader provide the interface typography.

The riverside image in [Photo walk](../apps/desktop/renderer/public/assets/photo-walk.png) is original AI-generated decorative artwork created for Eve. The README screenshots show the running macOS application with sample content. The banner is an original vector composition rendered for the project.

## Building blocks

Exact dependency versions are recorded in [package.json](../package.json) and [pnpm-lock.yaml](../pnpm-lock.yaml). This is an attribution guide, not a replacement for the license files distributed with each dependency.

| Building block | Role |
| --- | --- |
| [Electron](https://github.com/electron/electron) | Desktop host, isolated views and operating-system integration |
| [React](https://github.com/facebook/react) | Workspace presentation |
| [TypeScript](https://github.com/microsoft/TypeScript), [Vite](https://github.com/vitejs/vite), [esbuild](https://github.com/evanw/esbuild) | Typed implementation and builds |
| [SQLite](https://sqlite.org/), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | Durable local state |
| [code-server](https://github.com/coder/code-server), [VS Code](https://github.com/microsoft/vscode) | Real embedded coding workbench |
| [Tiptap](https://github.com/ueberdosis/tiptap), [Zod](https://github.com/colinhacks/zod), [DOMPurify](https://github.com/cure53/DOMPurify), [Marked](https://github.com/markedjs/marked) | Editing, validation and bounded content rendering |
| [Lucide](https://github.com/lucide-icons/lucide) | Interface icons |
| [Inter](https://github.com/rsms/inter), [Newsreader](https://github.com/productiontype/Newsreader), [Fontsource](https://github.com/fontsource/fontsource) | Interface typography; retain upstream font licenses in packaged builds |
| [Vitest](https://github.com/vitest-dev/vitest), [Playwright](https://github.com/microsoft/playwright) | Behavior, browser and native-desktop verification |

The workbench installer fetches the pinned official code-server archive and checks its SHA-256. Its upstream licenses remain part of the installed runtime. Remote tutorial material is linked or embedded through its provider, not redistributed as Eve-authored material.
