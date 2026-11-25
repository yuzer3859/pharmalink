-- Work 158: typo-tolerant search and suggestions (module-14 F-SR-01, F-SR-11, F-SR-14).
-- A plain lower-case copy of each document's searchable text, with a trigram index, lets a query
-- with a spelling mistake still find the product or pharmacy ("paracetmol" -> Paracetamol).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "search_documents" ADD COLUMN "searchText" TEXT;

UPDATE "search_documents"
SET "searchText" = lower(concat_ws(' ', "title", "subtitle", array_to_string("keywords", ' ')));

CREATE INDEX "search_documents_search_text_trgm_idx" ON "search_documents" USING GIN ("searchText" gin_trgm_ops);

-- Popular searches are read by their normalised text over a recent window.
CREATE INDEX "search_query_log_normalized_created_at_idx" ON "search_query_log" ("normalized", "createdAt");
