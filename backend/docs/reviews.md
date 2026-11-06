# Reviews (Module 15 minimum) and moderation: Work 91

Module 15's design is `architecture/module-15-reviews-ratings.md`. This work builds the minimum that
module-16 §9.3 needs ("review moderation", "unified flagged-content view"), and that the customer
app can use to rate a pharmacy. Its tables existed from the initial migration, so **no migration**
was needed. Each choice below is the recommended option.

## What a customer can do

- **`POST /reviews`** `{ orderId, pharmacyId?, rating, title?, body? }` (`review:create:own`, CUSTOMER).
  - **Verified purchase (BRULE-45).** The order must be the caller's and must be `DELIVERED` or
    `COMPLETED`. The subject is the pharmacy that fulfilled it, read through Module 06's
    `ORDER_REVIEW_ELIGIBILITY_PORT`.
  - **Split orders.** For an order split across pharmacies, `pharmacyId` names one of them.
  - **Refusals.** Anything else is `TRANSACTION_NOT_ELIGIBLE` (422).
  - **One review per order and pharmacy (BRULE-47).** This is the table's unique key, so a second
    review is `ALREADY_REVIEWED` (409).
  - **Content.** A rating is 1 to 5 stars; the title is up to 120 characters and the body up to 2,000.
- **`PATCH /reviews/{id}`.** The author may edit for **14 days**; after that the review is
  `EDIT_WINDOW_CLOSED`. A hidden or removed review cannot be edited.
- **`GET /reviews/mine`.**
- **`POST /reviews/{id}/report`** `{ reason, detail? }` with reason `SPAM`, `ABUSIVE`, `OFF_TOPIC`,
  `PERSONAL_DATA`, `HEALTH_DETAIL` or `OTHER`.
  - **One open report per person.** A repeat changes nothing.
  - **Threshold.** The **third distinct open report** holds a published review as `FLAGGED`.
  - **Own reviews.** A person cannot report their own review.

**Not built:**
- `GET /reviews/pending` (completed orders awaiting a review);
- votes;
- owner responses;
- media;
- subjects other than pharmacies (doctors, drivers and diagnostics follow Modules 09–12).

## What anyone can read

`GET /subjects/PHARMACY/{id}/reviews` (paged, newest first) and `.../rating` are public.
- **What is shown.** Only `PUBLISHED` reviews, as rating, title, text, "verified purchase", whether
  it was edited, and when it was published.
- **What is never shown.** The author and the order.
- **Rating.** `rating_aggregates` holds count, mean and the per-star distribution. It is rebuilt
  exactly from the published reviews, in the same transaction as every change.

## Automatic holding (BRULE-46, BRULE-37)

A review whose text contains a **link, an e-mail address or a phone number** (Ethiopian formats) is
not refused.
- **Held.** It is stored as `FLAGGED`, out of public view, with an automated `FLAG` entry in
  `moderation_logs` naming the rule.
- **Why these rules.** Such text is spam, or someone's personal data in a review of a pharmacy.
- **Edits.** The rules run again on every edit.
- **Not built.** Profanity lists and health-detail detection need Amharic and English lexicons
  reviewed by people, so they are not built.

## Moderation (Module 16)

`review:moderate:any` (ADMIN; SUPER_ADMIN by wildcard), through Module 15's `REVIEW_MODERATION_PORT`.

| Route | Does |
|---|---|
| `GET /admin/reviews?status&needsAttention` | Reviews; `needsAttention=true` is the queue (held, or with open reports) |
| `GET /admin/reviews/{id}` | One review, its open reports and its moderation log |
| `POST /admin/reviews/{id}/hide` `{reason}` | `PUBLISHED`/`FLAGGED` → `HIDDEN` |
| `POST /admin/reviews/{id}/remove` `{reason}` | `PUBLISHED`/`FLAGGED`/`HIDDEN` → `REMOVED` (final) |
| `POST /admin/reviews/{id}/restore` `{reason}` | `FLAGGED`/`HIDDEN` → `PUBLISHED` |
| `GET /admin/moderation/flagged` | The unified flagged-content view (below) |

Any other move is `INVALID_MODERATION_TRANSITION` (409). Each decision:
- is a compare-and-set on the status;
- resolves the open reports;
- writes `moderation_logs` (moderator and reason);
- recomputes the rating;
- is audited as `REVIEW_MODERATED`;
- emits `reviews.review.moderated` on the outbox.

That event becomes the author's `REVIEW_MODERATED` notification, in English and Amharic. It says
what happened, but never who decided or why. The Amharic copy was written by Claude and needs
native review.

### Unified flagged-content view

`GET /admin/moderation/flagged` lists everything awaiting a content decision, oldest first. It shows
up to 20 items per source, plus a total for each:

| Source | From | Why it is here |
|---|---|---|
| `REVIEW` | Module 15 | Open report reasons, and automatic rules as `AUTO_LINK`, `AUTO_EMAIL`, `AUTO_PHONE` |
| `CATALOG_PRODUCT` | Module 03 (`CATALOG_ADMIN_READ_PORT`) | `PENDING_REVIEW` |
| `CONTENT_DISPUTE` | Admin's disputes (Work 86), type `CONTENT`, open | Priority, or `OVERDUE` |

The view is read-only. Each item points to the queue that acts on it.

## Portal

The **Moderation** page in the admin and super admin portals has:
- the flagged-content view, with totals per source and a link to each queue;
- the review queue, filterable by status, with Hide, Remove and Restore. Each action needs a
  reason, which is kept in the log.
