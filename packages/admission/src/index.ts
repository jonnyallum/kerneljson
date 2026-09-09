export {
  AttachmentManifestItem,
  CompatibilityHints,
  EstateAdmissionRequest,
  ShadowVerdict,
} from "./estate-admission-request.js";
export {
  SHADOW_EMAIL_RECIPE,
  SHADOW_CONSUMER,
  LIVE_INGEST_SUFFIX,
  DEFAULT_MAILBOX_NAMESPACE,
  ESTATE_TENANT_ID,
  ESTATE_EMAIL_PRINCIPAL,
  normalizeEmailSourceEventId,
  estateDiscoveryKey,
  deriveIdempotencyKey,
  deriveKeyDigest,
  scrubObjectiveSubject,
  ownerHintFromAssignee,
  priorityHintFromUrgency,
  normalizeLiveSourceRef,
} from "./identity.js";
export {
  mapEmailToEstateAdmissionRequest,
  type EmailEnvelopeInput,
} from "./email-mapper.js";
export {
  simulateWouldBeAdmission,
  type SimulatedAdmission,
} from "./simulate-admission.js";
export {
  classifyShadowAdmission,
  type LegacyActionSnapshot,
  type PriorShadowAdmission,
  type CompareResult,
} from "./compare.js";
export {
  InMemoryShadowStore,
  StubSqlShadowStore,
  PostgrestShadowStore,
  createPostgrestShadowStoreFromEnv,
  type ShadowStoreWriter,
  type ShadowPersistInput,
  type ShadowRunRecord,
  type ShadowCompareRecord,
  type PostgrestShadowStoreOptions,
} from "./shadow-store.js";
export {
  CompatibilityAdmissionAdapter,
  type ShadowAdmissionResult,
} from "./compatibility-adapter.js";
