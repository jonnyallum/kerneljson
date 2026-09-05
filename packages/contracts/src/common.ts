import { z } from "zod";
export const Id = z.uuid();
export const Timestamp = z.iso.datetime({ offset: true });
export const Text = z.string().trim().min(1);
export const Json = z.json();
export const RiskClass = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const CapabilityRef = z.strictObject({ id: Id, version: Text });
