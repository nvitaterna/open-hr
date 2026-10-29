# 0010. Web UI: build, serving, live updates, and development

- Status: Accepted
- Date: 2026-10-29

## Context

Plan section 5.6 lists the pages and section 5.3 picks React, Vite,
Tailwind, and TanStack Query. Before the first page lands we need to settle
how the build reaches the browser, how pages stay current while a job runs,
how routing and theming work, and what `pnpm dev` does (plan section 9.1).

## Decision

### Package and build

- `packages/ui` is a Vite app: React 19, Tailwind 4 through its Vite plugin,
  TanStack Query for every API read, React Router for pages. `vite build`
  writes static files to `packages/ui/dist`. Nothing in the UI runs on the
  server.
- The UI imports schemas and helpers from `@ohr/shared` and only types from
  `@ohr/rpc`. Responses are typed with the shared types; the server already
  checked them against the contract, so the browser does not parse them
  again.
- Component tests run in Vitest with jsdom and Testing Library, against a
  stubbed `fetch`. End-to-end tests in a real browser come later (plan
  section 8.3).

### Serving

- `ohr-web --ui <dir>` serves the build with `@fastify/static`. Any `GET`
  outside `/api/` that is not a file answers `index.html`, so a reload on
  `/drives` works. Without `--ui`, web serves the API only.
- Every response carries a strict Content Security Policy
  (`default-src 'self'`, no inline scripts, `frame-ancestors 'none'`),
  `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.
  The UI needs nothing from another origin.

### Signing in

- The UI asks `GET /api/v1/setup` first. While setup is required it shows
  only the setup page. Otherwise `GET /api/v1/auth/me` decides between the
  sign-in page and the app. Any `401` from a later request drops back to the
  sign-in page.

### Live updates

- One `EventSource` on `/api/v1/events` per tab, opened after sign-in.
  `state.changed` invalidates the system, drive, and pool queries;
  `job.status` and `job.step` invalidate the job queries. Pages never poll.
- The header shows whether the stream is connected. The browser reconnects
  by itself after the `retry` interval web sends.

### Theme and layout

- Dark mode follows the system by default. A toggle cycles system, light,
  and dark, and the choice is kept in `localStorage`.
- One layout from phone to desktop: a top bar with navigation that wraps,
  and content in a single column that widens. Every action is a real
  `button` or link, so the keyboard works without extra code.

### Development

- `pnpm dev` runs `scripts/dev.sh`:
  - builds the server packages;
  - starts ohr-core under `sudo` on a private socket and database in `.dev/`;
  - starts ohr-web with `--insecure-http` on `127.0.0.1:7700`;
  - starts Vite on port 5173, which proxies `/api` to web.
- The first run prints the setup token. Ctrl-C stops all three.
- The proxy keeps the browser's `Host` header, so the origin check in
  decision 0008 passes without a special case for development.

## Consequences

- Shipping the UI is copying a directory; the `.deb` in PR 11 puts it under
  `/opt/ohr/ui` and passes `--ui`.
- Pages show what the cache in core holds, refreshed by events, so a page
  can lag the machine by as long as core takes to notice a change. That is
  the same view the CLI gets.
- The strict CSP rules out inline scripts and third-party assets, so any
  later chart or font has to be bundled.
