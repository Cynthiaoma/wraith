-- Give the periodic reconciliation sweep enough state to be bounded.
--
-- A webhook is a push, and a missed push used to leave an order non-terminal
-- forever. The sweep asks Linq for old orders, but without persisted attempt
-- counts a provider outage would make the same unresolvable order the oldest
-- candidate on every sweep. `needsHuman` stops that. `lastReconciledAt` records
-- when the last check happened, which makes the attempt history observable.
ALTER TABLE "wraith"."OfframpOrder"
  ADD COLUMN "reconciliationAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastReconciledAt" TIMESTAMP(3),
  ADD COLUMN "needsHuman" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "wraith"."NgnOrder"
  ADD COLUMN "reconciliationAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastReconciledAt" TIMESTAMP(3),
  ADD COLUMN "needsHuman" BOOLEAN NOT NULL DEFAULT false;

-- Both sweeps select the same shape: unflagged, below the attempt ceiling,
-- and older than the cutoff. Without this every sweep is a sequential scan.
CREATE INDEX "OfframpOrder_reconciliation_idx"
  ON "wraith"."OfframpOrder" ("needsHuman", "reconciliationAttempts", "createdAt");

CREATE INDEX "NgnOrder_reconciliation_idx"
  ON "wraith"."NgnOrder" ("needsHuman", "reconciliationAttempts", "createdAt");
