# PharmaLink — Healthcare Marketplace (Design Prototype)

A world-class, high-fidelity UI prototype for **PharmaLink Ethiopia** — a unified
digital healthcare marketplace connecting patients, licensed pharmacies, doctors,
diagnostic centers, and delivery partners.

Design language inspired by **Apple** (clarity), **Airbnb** (warmth), **Uber**
(live tracking), **Amazon** (marketplace depth), **Stripe** (checkout precision),
and **Google Material** (structure).

## Stack

- **React 18** + **Vite**
- **Tailwind CSS** (semantic design tokens + dark mode via CSS variables)
- **Framer Motion** (page transitions, micro-interactions)
- **lucide-react** (iconography)
- **react-router-dom** (navigation)

## Getting started

```bash
npm install
npm run dev
```

Open http://localhost:5174. (Port 5173 belongs to the operations portal in `web/`, so both can run at once.)

Customer authentication needs the backend running; the marketplace screens work without it.

## What's inside

| Route | Screen |
| --- | --- |
| `/` | Home — catalog search, live categories and newest products (backend); sample doctors |
| `/medicines` | Live catalog: search, type, Rx/OTC, category, sort, pagination (backend) |
| `/medicines/:id` | Product detail and pharmacy availability (backend) |
| `/doctors` | Doctor directory — specialty filters + appointment booking flow |
| `/diagnostics` | Lab tests, imaging & health screening packages |
| `/tracking` | Live order tracking (animated map + delivery timeline) |
| `/checkout` | Cart, address, payment methods & order confirmation |
| `/design-system` | Living design system: type, color, icons, components |
| `/register` | Customer sign-up with e-mail and password (backend) |
| `/verify-email` | Six-digit e-mail code, resend with the backend's cooldown (backend) |
| `/login` | E-mail and password sign-in (backend) |
| `/forgot-password` | Request a password-reset code (backend) |
| `/reset-password` | Code plus new password (backend) |
| `/account` | Signed-in customers only: details from `GET /users/me`, sign out (backend) |

## Design system highlights

- **Color:** "Trust Teal" primary + "Assurance Blue" accent, full semantic scale.
- **Typography:** Plus Jakarta Sans (display) + Inter (UI/body), tuned type scale.
- **Dark mode:** Class-based, token-driven, respects system preference.
- **Accessibility:** WCAG-AA contrast, visible focus rings, 44px targets,
  reduced-motion support, semantic landmarks.
- **Motion:** Spring-based sheets, staggered reveals, animated tracking.
- **Responsive:** Sidebar → mobile bottom-nav; fluid grids across breakpoints.

> Medicines come from the backend (Work 64, below). Doctors, diagnostics, tracking and checkout are
> still **simulated** with `src/data/mock.js`: checkout creates no order and takes no payment, and
> the doctor and diagnostics pages say they are sample data. Prescription upload is "coming soon".

## Medicine catalog and availability (Work 64)

The medicine pages read the backend's public Catalog (module 03) and Inventory (module 04)
endpoints. No sign-in is needed and no token is sent. Nothing is filled in by the browser: no mock
products, prices, ratings, stock, pharmacy names or locations.

| Endpoint | Used for |
|---|---|
| `GET /catalog/products` | Listing, search and filters; the home page's newest products (`sort=newest&size=4`) |
| `GET /catalog/categories` | Category filter (nested) and the home page's top-level categories |
| `GET /catalog/products/:id` | Product detail |
| `GET /availability/product/:id?limit=100` | Pharmacy availability on the detail page |

### Search, filters and pagination

- **Search** (`q`) matches product, brand and generic names (English and Amharic) on the server. It
  is debounced (350 ms); a newer query aborts the older request, and only the latest response is
  shown.
- **Filters** are only those the backend supports: product type (`MEDICINE`, `HEALTH_PRODUCT`),
  classification (`RX`, `OTC`) and category (a real category id). Categories are filtered by their
  `appliesTo`. A category filter matches products assigned **directly** to that category, not to
  its subcategories (that's how the backend works), and the page says so.
- **Sort:** relevance (the backend currently orders it newest first), name A–Z, newest.
- **Pagination:** 20 per page, using the backend's `meta.total`.
- The prototype's "In stock", "Nearby", price and rating options are removed: the catalog has no
  such data.
- All of it lives in the URL (`/medicines?q=…&type=…&rx=…&category=…&sort=…&page=…`), so a product
  page's "Back to medicines" returns to the same results. The header and home-page search boxes
  open this page.

### Product detail

Shows what `ProductDetailView` returns: name (English, and Amharic when present), brand, generic
name, dosage form, strength, pack size, Rx/OTC, controlled schedule, storage, warnings, description,
categories and a deprecated notice. Catalog text is labelled as not medical advice. Unknown,
draft and delisted products are "Product not found" (the backend returns 404); a malformed id is
answered as not found without a request.

### Availability and prices

- `Product.price` is the **catalog reference price** (ETB minor units, may be null). It is shown only
  as "Catalog reference price — platform reference only, not a pharmacy selling price".
- **Selling prices** come only from Inventory listings (`AvailabilityItem.price` + `currency`).
- The availability endpoint returns no pharmacy or branch names. Listings are therefore shown in
  aggregate: the number of available listings ("100+" at the request limit) and the selling-price
  range. Pharmacy, branch and listing ids are never displayed.
- No listings: "No pharmacy listings are available for this product right now" and no price. A
  failed request says availability couldn't be checked, which is not the same as out of stock.
- Products with `onlineSaleProhibited` show "Not available for online sale"; availability is not
  requested for them.
- **No location is sent** (`lat`/`lng` are never passed), so no distance or "nearby" label is shown.
  That waits for a customer address/location flow.
- Amounts are integer minor units, formatted without floating-point arithmetic
  (`formatMinorUnits` in `src/lib/utils.js`): `31050` ETB → `ETB 310.50`.
- There is no "Add to cart" yet; cart and checkout integration is separate work.

### Data needed for a demo

The backend's `prisma/seed.ts` seeds roles and permissions only: a fresh database has **no
products, categories or listings**, and the pages say so ("The catalog has no products yet.",
"No categories have been set up…"). To demonstrate the feature, a local database needs ACTIVE
catalog products (created and approved through the admin catalog flow), active categories assigned
to them, and an eligible pharmacy branch with enabled listings that have sellable stock.

## Customer authentication (Work 63)

Sign-up, e-mail verification, sign-in, session restore, sign-out and password reset call the real
backend (`backend/src/modules/identity`). Nothing is faked in the browser: no local accounts, no
locally generated or bypass codes, no "verified" flag the server didn't set.

### Configuration

| Setting | Where | Default |
|---|---|---|
| `VITE_API_BASE_URL` | `app/.env.local` (gitignored) or the shell | `http://localhost:3000` |

`VITE_` values are compiled into the page and visible to anyone. Never put Resend keys, JWT or OTP
secrets, or any other backend secret in them. The backend allows this app's origin through CORS:
by default it allows `http://localhost:5173` and `http://localhost:5174`; a deployment lists its
origins in the backend's `WEB_ORIGIN` (see `backend/docs/http-security.md`).

### Running it locally

1. Start the backend with its database and, optionally, Redis, as described in `backend/README.md`
   (from `backend/`: `npm run start:dev`; it listens on port 3000).
2. To have codes actually e-mailed, set both `RESEND_API_KEY` and `RESEND_FROM_EMAIL` in the backend's
   own untracked env file (`backend/.env`), never in this app and never committed. Resend's shared
   test sender (`onboarding@resend.dev`) only delivers to the Resend account owner's address.
3. From `app/`: `npm install`, then `npm run dev`, and open http://localhost:5174.

### Demo journey

1. **Create account** (`/register`): e-mail, password (8+ characters with upper case, lower case and a
   digit, the backend's policy) and preferred language (English or Amharic). No phone number: SMS
   verification isn't available yet.
2. **Verify e-mail** (`/verify-email`): the backend e-mails a six-digit code. Entering it activates the
   account and signs the customer in. "Send a new code" respects the backend's cooldown
   (`cooldownSeconds`, or `retryAfterSeconds` on a 429).
3. **Account** (`/account`): e-mail, verification status, account status and language, exactly as
   `GET /users/me` returns them, plus sign out.
4. **Sign in** (`/login`) with e-mail and password. Staff accounts (pharmacy, admin) are signed straight
   back out and pointed at the operations portal.
5. **Forgot password** (`/forgot-password`) shows the same message whether or not the address has an
   account. **Reset password** (`/reset-password`) takes the code and a new password; the customer then
   signs in again (the backend issues no session on reset).

**Without Resend configured**, the backend refuses to start a verification it can't deliver:
registration, "Send a new code" and "Forgot password" show "E-mail delivery is not set up on this
PharmaLink server, so no code was sent." No account is created and nothing is pretended.

### Sessions and tokens

- The **access token** is held in memory only. The **refresh token** is kept in `sessionStorage`, so a
  reload restores the session, and closing the tab ends it. There is no "remember me".
- Tokens are never put in URLs or logged, and only the auth service sees them; components get the
  user and actions from `useAuth()`.
- A 401 triggers one refresh and one retry. Refreshes are single-flight, because the backend rotates
  refresh tokens and treats a reused one as theft. Any rejection of the session clears it and
  returns the customer to sign-in with a notice. A network failure keeps the session for a retry.
- **Limitation:** `sessionStorage` is readable by script on this origin, so an XSS bug could read the
  refresh token. An httpOnly, SameSite cookie would avoid that but needs backend changes; it is not
  part of this demo.
- The device sent with each sign-in is `platform: WEB` with a random, non-secret per-browser id kept
  in `localStorage`, so repeated sign-ins reuse one device record.

### E-mail verification is not Fayda verification

A verified e-mail proves the customer controls that inbox, nothing more. The account page shows
"E-mail verified" and, separately, "Fayda identity verification is not yet connected." Fayda
integration and real SMS delivery are deferred.

### Localization and accessibility

All authentication text is in `src/auth/strings.js`, ready for translation. Only English is written:
the Amharic copy should come from a native speaker rather than a guess. Forms use real labels,
announce errors (`role="alert"`), work by keyboard, and the code field opens the numeric keypad,
accepts one-time-code autofill and strips spaces from a pasted code.

### Tests

```bash
npm test
```

Vitest with jsdom and Testing Library. All tests use a scripted `fetch` (`src/test/fakeBackend.js`):
no backend, no real credentials, no e-mail.

- `src/auth/authService.test.js`: API client, envelopes, registration, verification, resend cooldown,
  login, refresh and its single-flight guard, restore, logout, password recovery, malformed
  responses and network failures.
- `src/auth/authFlows.test.jsx`: the screens: validation, navigation to verification, code errors,
  successful verification, login errors, the protected account route, signed-in and signed-out
  navigation, sign-out, session expiry, the generic forgot-password message, reset, and Fayda shown
  apart from e-mail verification.
- `src/catalog/catalogService.test.js`: catalog query strings (only supported parameters), list,
  categories, detail and availability requests, envelopes, errors, malformed responses, network
  failures, cancellation, minor-unit formatting, availability aggregation, category flattening.
- `src/catalog/catalogFlows.test.jsx`: listing, debounce, stale-response protection, filters,
  categories, pagination, empty and error states with retry (no mock fallback), search context kept
  across detail pages, product fields, Rx/OTC, warnings, sale-prohibited products, availability
  (results, empty, failure), price labels, no pharmacy names or ids, and the home page.

`src/test/setup.js` replaces the global `fetch` with one that always fails, so no test can reach a
real server.
