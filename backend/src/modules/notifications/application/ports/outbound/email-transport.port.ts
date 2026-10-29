// Moved to the shared e-mail infrastructure (Work 62) so Module 01 can send OTP e-mail through the
// same transport without depending on this module. Re-exported here so Module 13 keeps its paths.
export * from '../../../../../shared/email/email-transport.port';
