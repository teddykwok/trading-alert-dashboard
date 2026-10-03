import { classifyOperatorFailure, type OperatorAccountId } from "../../api/operator-account";
import type { OperatorAuthState } from "./operatorSession";

/**
 * The selected account's CONTROL PLANE state, as the panel shows it.
 *
 * Kept apart from authentication on purpose: an offline control plane is not a
 * bad token, and a bad token is not an offline control plane. Pure, so the
 * rules are asserted directly rather than through a rendered component.
 */
export type ControlPlaneState = "LOADING" | "REACHABLE" | "UNREACHABLE" | "UNAUTHORIZED" | "ERROR";

/** What a failed read of the selected account says about its control plane. */
export function controlPlaneStateFromFailure(error: unknown): Exclude<ControlPlaneState, "LOADING" | "REACHABLE"> {
  const kind = classifyOperatorFailure(error);
  return kind === "UNAUTHORIZED" ? "UNAUTHORIZED" : kind === "UNREACHABLE" ? "UNREACHABLE" : "ERROR";
}

export function presentControlPlane(state: ControlPlaneState): { label: string; tone: "green" | "yellow" | "red" | "gray" } {
  switch (state) {
    case "REACHABLE":
      return { label: "Control plane reachable", tone: "green" };
    case "UNREACHABLE":
      return { label: "Control plane offline / unreachable", tone: "red" };
    case "UNAUTHORIZED":
      return { label: "Not authorized", tone: "yellow" };
    case "ERROR":
      return { label: "Control plane error", tone: "red" };
    default:
      return { label: "Checking control plane…", tone: "gray" };
  }
}

/**
 * Whether ANY mutation control may be offered. Every condition must hold:
 * exactly one account selected, its control plane proven reachable, the
 * operator authenticated FOR THAT ACCOUNT, and no request in flight.
 */
export function canOfferMutations(input: {
  readonly account: OperatorAccountId | null;
  readonly authState: OperatorAuthState;
  readonly controlPlane: ControlPlaneState;
  readonly requestInFlight: boolean;
}): boolean {
  return input.account !== null && input.authState === "AUTHENTICATED" && input.controlPlane === "REACHABLE" && !input.requestInFlight;
}
