-- Additive only: the SOFT open-position admission target, separate from the
-- HARD maxOpenPositions that already exists on this table.
--
-- Why two numbers instead of one: maxOpenPositions is (and stays) the hard
-- capacity the system must be able to hold safely. The soft target is the point
-- at which NEW admission closes and remaining live ENTRY orders are cancelled.
-- Because a cancellation can lose the race against a fill, open positions may
-- legitimately exceed the soft target and must still be protected normally —
-- so the soft target must NOT be expressed by lowering the hard cap.
--
-- DEFAULT 1 keeps every existing row behaving exactly as before (soft == hard
-- == 1): no admission that succeeds today starts failing because this column
-- appeared. Raising it is a deliberate, separately reviewed operator action.
--
-- No existing column is altered and no existing row changes meaning.
ALTER TABLE "ExecutionSafetyPolicy"
  ADD COLUMN IF NOT EXISTS "softOpenPositionTarget" INTEGER NOT NULL DEFAULT 1;
