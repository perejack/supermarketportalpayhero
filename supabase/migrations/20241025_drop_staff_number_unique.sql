-- Migration: Allow multiple independent applicants to share the same staff number
-- Run this in your Supabase SQL Editor: https://supabase.com/dashboard/project/nlnuscpzgutkfapyneaa/sql/new
--
-- Problem: The unique constraint applications_employer_staff_number_unique prevents
-- two different people from submitting with the same staff number under the same employer.
-- This must be dropped so every independent applicant gets their own row.

-- Step 1: Drop the existing unique constraint
ALTER TABLE public.applications 
  DROP CONSTRAINT IF EXISTS applications_employer_staff_number_unique;

-- Step 2: Verify it was removed (run this query to confirm)
-- SELECT conname, contype 
-- FROM pg_constraint 
-- WHERE conrelid = 'public.applications'::regclass AND contype = 'u';

-- Step 3: (Optional) Add a unique constraint on the primary key only (already exists as id)
-- No additional unique constraint needed.

-- Done. Each INSERT now creates an independent row regardless of staff_number duplicates.
