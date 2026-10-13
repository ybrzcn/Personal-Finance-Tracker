# Contributing / Katkı

Thanks for your interest! Issues and pull requests are welcome (English or Turkish).

## Development / Geliştirme

Requirements: Node 20+, Rust (stable), platform prerequisites for [Tauri 2](https://v2.tauri.app/start/prerequisites/).

```bash
npm ci
npm run tauri dev        # desktop app (local SQLite)
npm run dev              # UI only in the browser (localStorage, no server)

# web app against the server
(cd crates/finans-server && FINANS_SECURE_COOKIE=false cargo run)   # :8080
npm run dev:web                                                       # http://localhost:1430
```

Project layout:

- `src/` — React UI (shared by desktop and web); business logic in `src/lib/`
- `crates/finans-core/` — SQLite schema, migrations, data operations, statement parsing (shared by desktop and server)
- `crates/finans-server/` — self-hosted server (axum): accounts, per-user databases, REST API
- `src-tauri/` — desktop shell (Tauri commands are thin wrappers around `finans-core`)

## Before opening a PR / PR açmadan önce

```bash
npx tsc --noEmit && npx vite build && npx vite build --mode web
(cd crates/finans-server && cargo clippy -- -D warnings)
(cd src-tauri && cargo check)
node scripts/check-release-names.mjs
```

- Schema changes go into `crates/finans-core/src/db.rs` as a new `PRAGMA user_version` migration; never edit old migrations.
- Keep user-facing text in Turkish (the UI language).
- Never commit real financial data, statements or database files.
