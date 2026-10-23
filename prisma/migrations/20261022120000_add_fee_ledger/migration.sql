-- Fee quote ledger (W085): every fee GET /fees quotes, with the policy that
-- produced it, so a fee can be explained after the fact and an out-of-range
-- one raises an alarm.
--
-- Nothing here identifies a person: no IP, no user agent, no sender address.
-- FeePolicy is keyed by a hash of the policy itself, so one row per distinct
-- policy however many quotes it priced; FeeQuote.policyId points at it without
-- a foreign key, so a quote is never refused because its policy row lost a race.
CREATE TABLE "wraith"."FeePolicy" (
    "id" TEXT NOT NULL,
    "policy" JSONB NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeePolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wraith"."FeeQuote" (
    "id" SERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "assetCode" TEXT NOT NULL,
    "assetIssuer" TEXT,
    "quotedAgainst" TEXT,
    "fee" DECIMAL(38,7) NOT NULL,
    "basis" TEXT NOT NULL,
    "feePercent" DECIMAL(20,7),
    "alarm" BOOLEAN NOT NULL DEFAULT false,
    "policyId" TEXT NOT NULL,
    "quotedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeeQuote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FeeQuote_network_quotedAt_idx" ON "wraith"."FeeQuote"("network", "quotedAt");

CREATE INDEX "FeeQuote_network_alarm_quotedAt_idx" ON "wraith"."FeeQuote"("network", "alarm", "quotedAt");
