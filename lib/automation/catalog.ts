import { AutomationError, validateCapability, type Capability, type InputSpec, type Locator, type OutputSpec } from "./core.ts";

export type CapabilityVariant = {
  id: string;
  label: string;
  tenantId: string;
  vendorFamily: string;
  entryPoint: string;
  reviewState: "approved";
};

export type CapabilityCatalogEntry = {
  name: string;
  version: string;
  description: string;
  vendorFamily: string;
  risk: Capability["policy"]["risk"];
  inputs: Record<string, InputSpec>;
  outputs: Record<string, OutputSpec>;
  variants: CapabilityVariant[];
};

export type InvocationTicket = {
  invocationId: string;
  artifactHash: string;
  capabilityName: string;
  capabilityVersion: string;
  variant: CapabilityVariant;
  inputs: Record<string, string>;
  issuedAt: string;
  expiresAt: string;
  signature: string;
};

export type VerifiedInvocation = InvocationTicket & { artifact: Capability };

type ReviewedVariant = CapabilityVariant & {
  stepOverrides: Record<string, Locator[]>;
};

const REVIEWED_VARIANTS: ReviewedVariant[] = [
  {
    id: "northstar-main",
    label: "Main tenant",
    tenantId: "northstar-main",
    vendorFamily: "northstar-core-member-services@8",
    entryPoint: "/legacy",
    reviewState: "approved",
    stepOverrides: {},
  },
  {
    id: "northstar-east",
    label: "East branch tenant",
    tenantId: "northstar-east",
    vendorFamily: "northstar-core-member-services@8",
    entryPoint: "/legacy?variant=east",
    reviewState: "approved",
    stepOverrides: {
      enter_member_id: [
        { kind: "name", value: "member_number_east" },
        { kind: "css", value: "input[maxlength='5']" },
      ],
      submit_member_lookup: [
        { kind: "button_text", value: "Find Member" },
        { kind: "css", value: "form button[type='submit']" },
      ],
    },
  },
];

function publicVariant(variant: ReviewedVariant): CapabilityVariant {
  return {
    id: variant.id,
    label: variant.label,
    tenantId: variant.tenantId,
    vendorFamily: variant.vendorFamily,
    entryPoint: variant.entryPoint,
    reviewState: variant.reviewState,
  };
}

export function listCapabilityCatalog(baseArtifact: unknown): CapabilityCatalogEntry[] {
  const capability = validateCapability(baseArtifact);
  return [{
    name: capability.name,
    version: capability.version,
    description: capability.description,
    vendorFamily: REVIEWED_VARIANTS[0].vendorFamily,
    risk: capability.policy.risk,
    inputs: structuredClone(capability.inputs),
    outputs: structuredClone(capability.outputs),
    variants: REVIEWED_VARIANTS.map(publicVariant),
  }];
}

export function resolveCapabilityVariant(baseArtifact: unknown, variantId: string): { artifact: Capability; variant: CapabilityVariant } {
  const capability = structuredClone(validateCapability(baseArtifact));
  const profile = REVIEWED_VARIANTS.find((candidate) => candidate.id === variantId);
  if (!profile) throw new AutomationError("variant_not_approved", "invalid_request", `Variant ${variantId} is not in the reviewed catalog.`);

  capability.target.entryPoint = profile.entryPoint;
  for (const [stepId, locators] of Object.entries(profile.stepOverrides)) {
    const step = capability.steps.find((candidate) => candidate.id === stepId);
    if (!step || !("target" in step)) {
      throw new AutomationError("variant_invalid", "hard_failure", `Reviewed variant references unknown step ${stepId}.`);
    }
    step.target.locators = structuredClone(locators);
  }
  return { artifact: validateCapability(capability), variant: publicVariant(profile) };
}

export function validateInvocationInputs(capability: Capability, rawInputs: unknown): Record<string, string> {
  if (!rawInputs || typeof rawInputs !== "object" || Array.isArray(rawInputs)) {
    throw new AutomationError("invalid_input", "invalid_request", "Invocation inputs must be an object.");
  }
  const inputs = rawInputs as Record<string, unknown>;
  const normalized: Record<string, string> = {};
  for (const [name, spec] of Object.entries(capability.inputs)) {
    const value = inputs[name];
    if (spec.required && typeof value !== "string") throw new AutomationError("invalid_input", "invalid_request", `Input ${name} is required.`);
    if (typeof value !== "string") continue;
    if (spec.pattern && !new RegExp(spec.pattern).test(value)) throw new AutomationError("invalid_input", "invalid_request", `Input ${name} does not match its declared format.`);
    normalized[name] = value;
  }
  const unknown = Object.keys(inputs).find((name) => !Object.hasOwn(capability.inputs, name));
  if (unknown) throw new AutomationError("invalid_input", "invalid_request", `Input ${unknown} is not declared by this capability.`);
  return normalized;
}
