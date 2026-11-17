-- Work 135: the pharmacist requires the original paper prescription (a prescription request's quote).
ALTER TABLE "orders" ADD COLUMN "paperRxRequired" BOOLEAN NOT NULL DEFAULT false;
