-- Work 160: a hospital's, clinic's or lab's operating licence, decided like a pharmacy licence.
ALTER TYPE "VerificationType" ADD VALUE IF NOT EXISTS 'FACILITY_LICENSE';
