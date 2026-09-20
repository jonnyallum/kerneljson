/**
 * KJ-P4B.1: a SYNTHETIC signing key for tests only. It appears in the test worker's verifier and in the
 * test doors' signers, and the integration tests then prove it is absent from everything Restate stores.
 * It is deliberately distinctive so a leak into a journal or a log is obvious by search.
 */
export const CONTROL_TEST_KEY = "SYNTHETIC-CONTROL-SIGNING-KEY-FOR-TESTS-ONLY-0123456789-abcdefghij";
export const CONTROL_TEST_KEY_ID = "t1";
/** A different, equally synthetic key, for "wrong key" and rotation cases. */
export const CONTROL_OTHER_KEY = "SYNTHETIC-OTHER-SIGNING-KEY-FOR-TESTS-ONLY-9876543210-zyxwvutsrq";
