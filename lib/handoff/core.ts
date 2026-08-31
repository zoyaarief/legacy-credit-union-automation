import type { HumanAction } from "../automation/core.ts";

export type Ownership = "automation" | "human_requested" | "human" | "resuming" | "completed" | "failed";

export type HandoffState = {
  owner: Ownership;
  interventionId: string | null;
  actions: HumanAction[];
};

export type HandoffEvent =
  | { type: "request"; interventionId: string }
  | { type: "accept" }
  | { type: "record"; action: HumanAction }
  | { type: "resume" }
  | { type: "complete" }
  | { type: "fail" }
  | { type: "reset" };

export const INITIAL_HANDOFF_STATE: HandoffState = {
  owner: "automation",
  interventionId: null,
  actions: [],
};

export function terminalResumeEvent(status: "success" | "business_outcome" | "failure"): Extract<HandoffEvent, { type: "complete" | "fail" }> {
  return status === "failure" ? { type: "fail" } : { type: "complete" };
}

export function transitionHandoff(state: HandoffState, event: HandoffEvent): HandoffState {
  if (event.type === "reset") return INITIAL_HANDOFF_STATE;
  if (event.type === "request" && ["automation", "resuming"].includes(state.owner)) {
    return { owner: "human_requested", interventionId: event.interventionId, actions: [] };
  }
  if (event.type === "accept" && state.owner === "human_requested") {
    return { ...state, owner: "human" };
  }
  if (event.type === "record" && state.owner === "human") {
    return { ...state, actions: [...state.actions, redactHumanAction(event.action)] };
  }
  if (event.type === "resume" && state.owner === "human") {
    return { ...state, owner: "resuming" };
  }
  if (event.type === "complete" && ["automation", "resuming"].includes(state.owner)) {
    return { ...state, owner: "completed" };
  }
  if (event.type === "fail" && state.owner === "resuming") {
    return { ...state, owner: "failed" };
  }
  throw new Error(`Invalid handoff transition: ${state.owner} -> ${event.type}`);
}

export function redactHumanAction(action: HumanAction): HumanAction {
  return {
    ...action,
    control: action.control
      .replace(/\b\d{5,}\b/g, "[REDACTED_ID]")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
      .slice(0, 120),
  };
}
