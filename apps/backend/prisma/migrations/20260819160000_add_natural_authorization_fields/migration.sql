-- Phase 12.1 — SCHEMA ONLY. Additive; no production code reads these columns.
--
-- Gives ExecutionCanaryAuthorization a second possible shape (NATURAL_WINDOW)
-- without changing the meaning of a single existing row. Nothing here can make
-- a natural window executable: this migration adds representation, and the
-- admission path is untouched.
--
-- WHY DEFAULT 'EXACT_SIGNAL' IS THE LOAD-BEARING LINE
-- Every row already on file was written by the Phase 11B.0 one-shot flow. The
-- default is what turns "the column did not exist" into "the column says
-- EXACT_SIGNAL", with no backfill script, no data transformation and no
-- inference from which fields happen to be null. A historical row cannot
-- become a NATURAL_WINDOW by accident, because becoming one additionally
-- requires a non-empty allowedDirections and a maxClaims, and this migration
-- gives every existing row the opposite of both.
--
-- No table is recreated, no column is dropped, no value is rewritten, and the
-- unique index on tokenHash is left exactly as it was.

-- CreateEnum
CREATE TYPE "CanaryAuthorizationType" AS ENUM ('EXACT_SIGNAL', 'NATURAL_WINDOW');

-- AlterTable: the discriminator and the natural-window fields.
--
-- allowedDirections defaults to the EMPTY array, which admits nothing. maxClaims
-- is deliberately nullable with NO default: a window with no number would be a
-- window with no ceiling, so the absence of a budget must be an error at the
-- domain layer rather than a silent "unlimited".
ALTER TABLE "ExecutionCanaryAuthorization"
  ADD COLUMN IF NOT EXISTS "authorizationType" "CanaryAuthorizationType" NOT NULL DEFAULT 'EXACT_SIGNAL',
  ADD COLUMN IF NOT EXISTS "allowedDirections" "CanaryDirection"[] DEFAULT ARRAY[]::"CanaryDirection"[],
  ADD COLUMN IF NOT EXISTS "maxClaims" INTEGER,
  ADD COLUMN IF NOT EXISTS "claimedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable: relax the three EXACT_SIGNAL-only identity columns.
--
-- A NATURAL_WINDOW has no single symbol, no single direction and no operator
-- token, so all three must be able to be absent. Dropping NOT NULL cannot
-- change an existing row: every one of them already holds a value, and nothing
-- in this migration writes to them.
--
-- tokenHash keeps its UNIQUE index. PostgreSQL treats NULLs as distinct under a
-- unique index, so any number of tokenless windows coexist while the
-- one-token-one-row guarantee for exact rows is untouched.
ALTER TABLE "ExecutionCanaryAuthorization" ALTER COLUMN "allowedSymbol" DROP NOT NULL;
ALTER TABLE "ExecutionCanaryAuthorization" ALTER COLUMN "allowedDirection" DROP NOT NULL;
ALTER TABLE "ExecutionCanaryAuthorization" ALTER COLUMN "tokenHash" DROP NOT NULL;
