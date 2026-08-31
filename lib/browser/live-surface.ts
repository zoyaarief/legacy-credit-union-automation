import {
  AutomationError,
  HumanInterventionError,
  type ControlTarget,
  type HumanAction,
  type Locator,
  type OutcomeDefinition,
  type SurfaceAdapter,
} from "../automation/core.ts";
import {
  redactDiscoveryText,
  type DiscoveryAdapter,
  type DiscoveryDecision,
  type ObservedControl,
} from "../discovery/core.ts";

export type FaultMode = "none" | "session_expired" | "slow_load" | "application_error";

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const timer = window.setTimeout(() => {
    signal.removeEventListener("abort", abort);
    resolve();
  }, ms);
  const abort = () => {
    window.clearTimeout(timer);
    reject(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });
});

function getDocument(frame: HTMLIFrameElement) {
  const document = frame.contentDocument;
  if (!document) throw new AutomationError("target_unavailable", "recoverable", "The target application is not available.", true);
  return document;
}

function isVisible(element: Element) {
  if (element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (style && (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0)) return false;
  return [...element.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0);
}

function isEnabled(element: Element) {
  if (element.closest("[inert], [aria-disabled='true']")) return false;
  return !("disabled" in element && Boolean((element as HTMLButtonElement | HTMLInputElement).disabled));
}

function findTarget(document: Document, target: ControlTarget, requireEnabled = false) {
  let ambiguous: string | null = null;
  let disabled: string | null = null;
  for (const candidate of target.locators) {
    let matches: Element[] = [];
    if (candidate.kind === "name") matches = [...document.querySelectorAll(`[name="${CSS.escape(candidate.value)}"]`)];
    if (candidate.kind === "css") matches = [...document.querySelectorAll(candidate.value)];
    if (candidate.kind === "button_text") {
      matches = [...document.querySelectorAll("button, input[type='submit']")].filter(
        (item) => (item.textContent?.trim() || item.getAttribute("value")) === candidate.value,
      );
    }
    const locator = `${candidate.kind}:${candidate.value}`;
    const visible = matches.filter(isVisible);
    const usable = requireEnabled ? visible.filter(isEnabled) : visible;
    if (usable.length === 1) return { element: usable[0], locator };
    if (usable.length > 1) ambiguous = locator;
    if (requireEnabled && visible.length && !usable.length) disabled = locator;
  }
  if (ambiguous) throw new AutomationError("locator_ambiguous", "hard_failure", `Locator ${ambiguous} matched multiple visible controls for ${target.description}.`);
  if (disabled) throw new AutomationError("target_not_interactable", "hard_failure", `${target.description} is visible but disabled.`);
  return null;
}

function requireTarget(document: Document, target: ControlTarget, requireEnabled = false) {
  const found = findTarget(document, target, requireEnabled);
  if (!found) throw new AutomationError("locator_not_found", "hard_failure", `No locator matched ${target.description}.`);
  return found;
}

async function reloadFrame(frame: HTMLIFrameElement, entryPoint: string, run: number, signal: AbortSignal, faultMode: FaultMode = "none") {
  await new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const cleanup = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      frame.onload = null;
      reject(signal.reason);
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new AutomationError("target_timeout", "recoverable", "Target load timed out.", true));
    }, 5000);
    signal.addEventListener("abort", abort, { once: true });
    frame.onload = () => {
      const deadline = Date.now() + 2000;
      let stableSince = 0;
      let priorSignature = "";
      const checkReady = () => {
        if (signal.aborted) return;
        try {
          const document = frame.contentDocument;
          const interactive = document ? [...document.querySelectorAll("input, select, button")].filter(isVisible) : [];
          const signature = interactive.map((element) => `${element.tagName}:${element.getAttribute("name") ?? ""}:${element.textContent?.trim() ?? ""}:${isEnabled(element)}`).join("|");
          if (document?.readyState === "complete" && interactive.length >= 2 && signature === priorSignature) {
            if (!stableSince) stableSince = Date.now();
          } else {
            stableSince = 0;
            priorSignature = signature;
          }
          if (stableSince && Date.now() - stableSince >= 100) {
            cleanup();
            resolve();
            return;
          }
        } catch {
          cleanup();
          reject(new AutomationError("policy_denied", "policy_denied", "The target surface became cross-origin."));
          return;
        }
        if (Date.now() >= deadline) {
          cleanup();
          reject(new AutomationError("target_not_ready", "recoverable", "Target loaded but did not become interactive.", true));
          return;
        }
        window.setTimeout(checkReady, 25);
      };
      checkReady();
    };
    const target = new URL(entryPoint, window.location.origin);
    target.searchParams.set("embedded", "1");
    target.searchParams.set("run", String(run));
    if (faultMode !== "none") target.searchParams.set("fault", faultMode);
    frame.src = `${target.pathname}${target.search}`;
  });
}

function currentFrameUrl(frame: HTMLIFrameElement) {
  try {
    return frame.contentWindow?.location.href ?? "";
  } catch {
    throw new AutomationError("policy_denied", "policy_denied", "The live surface became cross-origin.");
  }
}

function captureSurfaceSnapshot(frame: HTMLIFrameElement) {
  const document = getDocument(frame);
  return {
    surface: "web" as const,
    path: new URL(currentFrameUrl(frame)).pathname,
    title: document.title || "Northstar Core Member Services",
    visibleSignals: [...document.querySelectorAll("[role='dialog'], .legacy-message, .member-result")]
      .filter(isVisible)
      .map((element) => redactDiscoveryText(element.textContent?.replace(/\s+/g, " ").trim() ?? "").slice(0, 180))
      .filter(Boolean)
      .slice(0, 8),
    sanitizedDom: redactDiscoveryText(document.body.innerText.replace(/\s+/g, " ").trim()).slice(0, 4000),
  };
}

async function typeIntoTarget(frame: HTMLIFrameElement, target: ControlTarget, value: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const found = requireTarget(getDocument(frame), target, true);
  const input = found.element as HTMLInputElement;
  const targetWindow = frame.contentWindow;
  if (!targetWindow) throw new AutomationError("target_unavailable", "recoverable", "The target window is unavailable.", true);
  const constructors = targetWindow as unknown as { HTMLInputElement: typeof HTMLInputElement; Event: typeof Event };
  const nativeValueSetter = Object.getOwnPropertyDescriptor(constructors.HTMLInputElement.prototype, "value")?.set;
  if (!nativeValueSetter) throw new AutomationError("control_not_editable", "hard_failure", `${target.description} cannot accept values.`);
  signal.throwIfAborted();
  input.focus();
  nativeValueSetter.call(input, value);
  input.dispatchEvent(new constructors.Event("input", { bubbles: true }));
  input.dispatchEvent(new constructors.Event("change", { bubbles: true }));
  await pause(50, signal);
  return found.locator;
}

async function clickTarget(frame: HTMLIFrameElement, target: ControlTarget, signal: AbortSignal) {
  signal.throwIfAborted();
  const found = requireTarget(getDocument(frame), target, true);
  if (found.element.closest("[role='dialog']")) {
    throw new AutomationError("human_only_control", "policy_denied", "Automation cannot activate a control inside an operator dialog.");
  }
  signal.throwIfAborted();
  (found.element as HTMLElement).click();
  return found.locator;
}

async function waitForOutcomes(frame: HTMLIFrameElement, outcomes: OutcomeDefinition[], timeoutMs: number, signal: AbortSignal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const document = getDocument(frame);
    const visibleText = document.body.textContent ?? "";
    if (/OPERATOR SESSION EXPIRED/i.test(visibleText)) throw new AutomationError("session_expired", "recoverable", "The operator session expired before the result was available.", true);
    if (/CORE MEMBER SERVICES IS UNAVAILABLE/i.test(visibleText)) throw new AutomationError("application_unavailable", "hard_failure", "Core Member Services returned an application error.");
    if ([...document.querySelectorAll("[role='dialog']")].some(isVisible)) {
      throw new HumanInterventionError(
        "operator_acknowledgment_required",
        "Automation paused at a restricted-account acknowledgment and routed the live session to an operator.",
        { surface: "web", path: new URL(currentFrameUrl(frame)).pathname, title: document.title || "Northstar Core Member Services", visibleSignals: ["permission_dialog", "continue_lookup", "session_active"] },
      );
    }
    for (const outcome of outcomes) if (findTarget(document, outcome.target)) return outcome;
    await pause(100, signal);
  }
  throw new AutomationError("outcome_timeout", "recoverable", "No declared outcome appeared before the step timeout.", true);
}

export function createReplayAdapter(frame: HTMLIFrameElement, nextRun: () => number, faultMode: FaultMode = "none"): SurfaceAdapter {
  return {
    prepare: (entryPoint, signal) => reloadFrame(frame, entryPoint, nextRun(), signal, faultMode),
    currentUrl: () => currentFrameUrl(frame),
    sessionIdentity: () => currentFrameUrl(frame),
    snapshot: async (signal) => { signal.throwIfAborted(); return captureSurfaceSnapshot(frame); },
    type: (target, value, signal) => typeIntoTarget(frame, target, value, signal),
    click: (target, signal) => clickTarget(frame, target, signal),
    waitForOutcome: (outcomes, timeoutMs, signal) => waitForOutcomes(frame, outcomes, timeoutMs, signal),
    async extract(target, signal) {
      signal.throwIfAborted();
      const found = requireTarget(getDocument(frame), target);
      return { value: found.element.textContent?.trim() ?? "", locator: found.locator };
    },
    async verify(target, signal) { signal.throwIfAborted(); return Boolean(findTarget(getDocument(frame), target)); },
  };
}

function uniqueLocators(document: Document, element: Element): Locator[] {
  const candidates: Locator[] = [];
  const add = (candidate: Locator) => {
    if (!candidates.some((item) => item.kind === candidate.kind && item.value === candidate.value)) candidates.push(candidate);
  };
  const name = element.getAttribute("name");
  if (name) add({ kind: "name", value: name });
  if (element.tagName === "BUTTON") {
    const text = element.textContent?.trim();
    if (text) add({ kind: "button_text", value: text });
  }
  if (element.id) add({ kind: "css", value: `#${CSS.escape(element.id)}` });
  for (const className of element.classList) {
    const selector = `.${CSS.escape(className)}`;
    if (document.querySelectorAll(selector).length === 1) add({ kind: "css", value: selector });
  }
  if (element.classList.length > 1) {
    const selector = [...element.classList].map((item) => `.${CSS.escape(item)}`).join("");
    if (document.querySelectorAll(selector).length === 1) add({ kind: "css", value: selector });
  }
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.body) {
    let part = current.tagName.toLowerCase();
    const parentElement: Element | null = current.parentElement;
    if (parentElement) {
      const sameTag = [...parentElement.children].filter((item) => item.tagName === current?.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    const selector = parts.join(" > ");
    if (document.querySelectorAll(selector).length === 1) add({ kind: "css", value: selector });
    current = parentElement;
  }
  return candidates.slice(0, 4);
}

function observedControl(document: Document, element: Element, index: number): ObservedControl | null {
  if (!isVisible(element)) return null;
  const clean = (value: string) => redactDiscoveryText(value.replace(/\s+/g, " ").trim()).slice(0, 180);
  let role: ObservedControl["role"];
  let name = "";
  let context = "";
  if (element.tagName === "INPUT") {
    role = "textbox";
    name = element.closest("tr")?.querySelector("th")?.textContent ?? element.getAttribute("name") ?? "Text input";
    context = "Editable field in the member inquiry form";
  } else if (element.tagName === "SELECT") {
    role = "combobox";
    name = element.closest("tr")?.querySelector("th")?.textContent ?? element.getAttribute("name") ?? "Selection";
    context = "Selection field in the member inquiry form";
  } else if (element.tagName === "BUTTON") {
    role = "button";
    name = element.textContent ?? "Button";
    context = element.closest("[role='dialog']") ? "Operator dialog action" : "Member inquiry action";
  } else if (element.getAttribute("role") === "dialog") {
    role = "dialog";
    name = element.querySelector(".legacy-dialog-title")?.textContent ?? "Operator dialog";
    context = element.querySelector("p")?.textContent ?? "Manual intervention surface";
  } else if (element.classList.contains("legacy-message")) {
    role = "status";
    name = element.textContent ?? "Application status";
    context = "Visible application outcome or error";
  } else if (element.classList.contains("member-result")) {
    role = "region";
    name = element.querySelector(".legacy-window-title")?.textContent ?? "Result region";
    context = "Visible member and account summary checkpoint";
  } else if (["TD", "TH"].includes(element.tagName)) {
    role = "text";
    const cell = element as HTMLTableCellElement;
    const table = element.closest("table");
    const header = table?.querySelectorAll("thead th")[cell.cellIndex]?.textContent ?? "Result";
    const description = element.parentElement?.children[1]?.textContent ?? "account row";
    name = `${header} cell`;
    context = `Account row: ${description}`;
  } else {
    return null;
  }
  const locatorCandidates = uniqueLocators(document, element);
  if (locatorCandidates.length < 2) return null;
  return {
    ref: `control-${index + 1}`,
    role,
    name: clean(name),
    context: clean(context),
    visible: true,
    enabled: ["textbox", "combobox", "button"].includes(role) ? isEnabled(element) : undefined,
    filled: element.tagName === "INPUT" ? Boolean((element as HTMLInputElement).value) : undefined,
    hasValue: role === "text" ? Boolean(element.textContent?.trim()) : undefined,
    humanOnly: element.tagName === "BUTTON" && Boolean(element.closest("[role='dialog']")),
    outputBinding: role === "text"
      ? /current\s+balance/i.test(name)
        ? "balance"
        : /^status\s+cell$/i.test(name.trim())
          ? "accountStatus"
          : undefined
      : undefined,
    locatorCandidates,
  };
}

function surfaceSignature(document: Document) {
  return [...document.querySelectorAll("input, select, button, [role='dialog'], .legacy-message, .member-result, .accounts-grid tbody td")]
    .filter(isVisible)
    .map((element) => `${element.tagName}:${element.textContent?.replace(/\s+/g, " ").trim()}:${isEnabled(element)}`)
    .join("|");
}

async function waitForChange(frame: HTMLIFrameElement, timeoutMs: number, signal: AbortSignal) {
  const initial = surfaceSignature(getDocument(frame));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const document = getDocument(frame);
    const visibleText = document.body.textContent ?? "";
    if (/OPERATOR SESSION EXPIRED/i.test(visibleText)) throw new AutomationError("session_expired", "recoverable", "The operator session expired during discovery.", true);
    if (/CORE MEMBER SERVICES IS UNAVAILABLE/i.test(visibleText)) throw new AutomationError("application_unavailable", "hard_failure", "Core Member Services returned an application error.");
    if (surfaceSignature(document) !== initial) return;
    await pause(100, signal);
  }
  throw new AutomationError("outcome_timeout", "recoverable", "The live surface did not change before the discovery timeout.", true);
}

export function createDiscoveryAdapter(frame: HTMLIFrameElement, nextRun: () => number): DiscoveryAdapter {
  return {
    prepare: (entryPoint, signal) => reloadFrame(frame, entryPoint, nextRun(), signal),
    currentUrl: () => currentFrameUrl(frame),
    sessionIdentity: () => currentFrameUrl(frame),
    snapshot: async (signal) => { signal.throwIfAborted(); return captureSurfaceSnapshot(frame); },
    async observe(signal) {
      signal.throwIfAborted();
      const document = getDocument(frame);
      const elements = [...document.querySelectorAll("input, select, button, [role='dialog'], .legacy-message, .member-result, .accounts-grid tbody td")];
      const controls = elements.map((element, index) => observedControl(document, element, index)).filter((control): control is ObservedControl => Boolean(control));
      return { url: currentFrameUrl(frame), title: document.title || "Northstar Core Member Services", controls };
    },
    async execute(decision: DiscoveryDecision, inputs: Record<string, string>, signal: AbortSignal) {
      signal.throwIfAborted();
      if (decision.action === "wait_for_change") {
        await waitForChange(frame, 5000, signal);
        return {};
      }
      if (!decision.target) throw new AutomationError("model_contract_invalid", "hard_failure", "Decision target is missing.");
      if (decision.action === "type") {
        if (!decision.input) throw new AutomationError("model_contract_invalid", "hard_failure", "Decision input is missing.");
        return { locator: await typeIntoTarget(frame, decision.target, inputs[decision.input], signal) };
      }
      if (decision.action === "click") return { locator: await clickTarget(frame, decision.target, signal) };
      if (decision.action === "extract") {
        const found = requireTarget(getDocument(frame), decision.target);
        const value = found.element.textContent?.trim() ?? "";
        if (!value) throw new AutomationError("output_missing", "hard_failure", `${decision.output} was empty.`);
        return { value, locator: found.locator };
      }
      throw new AutomationError("model_contract_invalid", "hard_failure", "Complete actions are verified by the discovery engine.");
    },
    async verify(target, signal) { signal.throwIfAborted(); return Boolean(findTarget(getDocument(frame), target)); },
  };
}

export function captureHumanActions(frame: HTMLIFrameElement, onAction: (action: HumanAction) => void) {
  const document = getDocument(frame);
  const describe = (element: Element) => (element.getAttribute("aria-label") || element.textContent || element.getAttribute("name") || element.tagName).trim().slice(0, 120);
  const click = (event: Event) => {
    const control = (event.target as Element | null)?.closest("button, a, input, select, textarea");
    if (control) onAction({ at: new Date().toISOString(), kind: "click", control: describe(control) });
  };
  const input = (event: Event) => {
    const control = event.target as Element | null;
    if (control) onAction({ at: new Date().toISOString(), kind: "input", control: control.getAttribute("name") || control.tagName });
  };
  document.addEventListener("click", click, true);
  document.addEventListener("change", input, true);
  return () => {
    document.removeEventListener("click", click, true);
    document.removeEventListener("change", input, true);
  };
}
