-- Module 05/06 — bind checkout-created match requests to their order.
--
-- Checkout now pre-allocates the order id and passes it to `IMatchingPort.find()`, so every new
-- match request it creates carries `orderId`. A bound match request refuses the customer's own
-- `POST /matching/:id/select` and `/rematch` (`MATCH_REQUEST_ORDER_BOUND`); only Module 06's
-- in-process calls (checkout's select, the pharmacy-decline rematch) may move it. Without the bind,
-- a customer rematch released a placed order's live reservations and repointed only the match
-- request, leaving the order lines on RELEASED reservations.
--
-- Data-only backfill for orders placed before this change: their match request has `orderId` NULL
-- and the order references it via `orders.matchRequestId`. Additive (ADR-003) — no schema change,
-- and only rows still unbound are touched. Existing reservations keep the match-request id they
-- were created with in `stock_reservations.orderId`; nothing reads that column for orders.
UPDATE "match_requests" AS mr
SET "orderId" = o."id"
FROM "orders" AS o
WHERE o."matchRequestId" = mr."id"
  AND mr."orderId" IS NULL;
