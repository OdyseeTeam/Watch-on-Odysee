# Repository Guidelines

## Project Structure & Module Organization
- Source: `src/` (TypeScript + Preact).
  - `pages/` (popup, import, YTtoLBRY UI), `components/`, `scripts/` (e.g., `background.ts`, `ytContent.tsx`), `modules/` (e.g., `yt/`, `crypto/`, `file/`), `settings/`, `assets/`.
- Build output: `dist/` (watch/build), zipped bundles in `build/`.
- Config: `tsconfig.json`, `babel.config.js`, `jest.config.js`, `manifest.v2.json`, `manifest.v3.json`.
- Docs: `doc/` (e.g., privacy, images).

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run watch` (or `watch:v3`): start Parcel + asset watcher with MV3 manifest.
- `npm run start:chrome` | `start:firefox`: run the built `dist/` with `web-ext`.
- `npm run build`: produce MV2+MV3 zips under `build/`.
- `npm run build:v2` | `build:v3`: build a single manifest target.
- `npm test`: run Jest.

Example local loop: `npm run watch` in one terminal, then `npm run start:chrome` in another.

## Coding Style & Naming Conventions
- Language: TypeScript (strict), Preact JSX (`jsxFactory: h`).
- Indentation: 2 spaces; prefer single quotes; avoid semicolons unless required.
- Files/dirs: prefer `kebab-case` for new files; components export names in `PascalCase`. Do not rename existing files for style only.
- Keep content scripts/background lean; extract pure helpers in `src/modules/*`.

## Testing Guidelines
- Framework: Jest (v8 coverage provider). No strict threshold enforced.
- Place tests alongside code (`*.test.ts`/`*.test.tsx`) or under `__tests__/`.
- Focus on pure logic in `src/modules/*`; mock DOM/Chrome APIs when needed.
- Run `npm test` (add `--watch` locally if desired).

## Commit & Pull Request Guidelines
- Commits are short, imperative (emojis are used informally; no strict conventional commits).
- PRs: clear description, linked issues, before/after screenshots or short GIFs for UI, test plan, and manual steps to verify in Chrome/Firefox.
- Keep changes scoped; include updates to `manifest.*` and assets when relevant.

## Architecture Overview
- Browser extension with content scripts + background/service worker (`src/service-worker-entry-point.ts`).
- Built with Parcel; assets copied via `cpx`; packaged/run via `web-ext`.
- Targets both MV2 and MV3; pick manifest with `build:v2`/`build:v3` or `watch:v2`/`watch:v3`.
