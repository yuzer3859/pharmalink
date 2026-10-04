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

Open the printed local URL (default http://localhost:5173).

## What's inside

| Route | Screen |
| --- | --- |
| `/` | Home — hero search, quick actions, categories, featured products & doctors |
| `/medicines` | Medicine catalog — filters, Rx upload, live search & sort |
| `/doctors` | Doctor directory — specialty filters + appointment booking flow |
| `/diagnostics` | Lab tests, imaging & health screening packages |
| `/tracking` | Live order tracking (animated map + delivery timeline) |
| `/checkout` | Cart, address, payment methods & order confirmation |
| `/design-system` | Living design system: type, color, icons, components |

## Design system highlights

- **Color:** "Trust Teal" primary + "Assurance Blue" accent, full semantic scale.
- **Typography:** Plus Jakarta Sans (display) + Inter (UI/body), tuned type scale.
- **Dark mode:** Class-based, token-driven, respects system preference.
- **Accessibility:** WCAG-AA contrast, visible focus rings, 44px targets,
  reduced-motion support, semantic landmarks.
- **Motion:** Spring-based sheets, staggered reveals, animated tracking.
- **Responsive:** Sidebar → mobile bottom-nav; fluid grids across breakpoints.

> Data is mocked in `src/data/mock.js` for prototype purposes.
