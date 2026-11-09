# PharmaLink driver app

The driver's own app for Phase 1: sign in, go online, take offers within their time limit, carry
the active job, record proof of delivery, collect cash on delivery, and see earnings. The design is
in [`architecture/driver-app.md`](../architecture/driver-app.md).

The stack and conventions are the customer app's (`app/`): React 18, Vite, Tailwind, React Router
and Vitest with React Testing Library.

## Run against a backend

```sh
cd driver
npm ci
VITE_API_BASE_URL=http://127.0.0.1:3000 npx vite --port 5175 --strictPort
```

Open `http://localhost:5175`. The backend's default CORS list allows 5173 (operations portal),
5174 (customer app) and 5175 (this app). A deployment that sets `WEB_ORIGIN` must list
`http://localhost:5175` or the app's real origin.

## Accounts

Drivers sign in with e-mail and password through `POST /auth/login`; SMS is not available. Only an
account with the `DRIVER` role and a driver profile is accepted. Customer and staff accounts get a
clear message instead.

On staging, the walk drivers are seeded fixtures:
- `driver.walk@staging.pharmalink.test`
- `driver.spare@staging.pharmalink.test`

The owner sets their passwords with `npm run staging:set-password`.

## Tests

```sh
npm test
```

The tests use a scripted fetch (`src/test/fakeBackend.js`). Nothing reaches a server. CI runs them
with the production build (`.github/workflows/driver-ci.yml`).
