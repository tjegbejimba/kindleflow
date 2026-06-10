import { describe, expect, it } from "vitest";
import {
  computeOnboardingState,
  hasSuccessfulDelivery,
  onboardingDismissedKey,
  onboardingSenderConfirmedKey,
  type OnboardingInput
} from "../client/src/onboarding.js";

const baseInput: OnboardingInput = {
  emailDeliveryEnabled: true,
  kindleEmailSet: false,
  senderConfirmed: false,
  testDeliverySucceeded: false,
  dismissed: false
};

describe("computeOnboardingState", () => {
  it("is visible with no steps complete for a brand-new user", () => {
    const state = computeOnboardingState(baseInput);
    expect(state.visible).toBe(true);
    expect(state.completedCount).toBe(0);
    expect(state.totalCount).toBe(3);
    expect(state.setupComplete).toBe(false);
  });

  it("marks the Kindle email step complete once an email is set", () => {
    const state = computeOnboardingState({ ...baseInput, kindleEmailSet: true });
    expect(state.steps.find((step) => step.id === "kindle-email")?.complete).toBe(true);
    expect(state.completedCount).toBe(1);
    expect(state.visible).toBe(true);
  });

  it("completes setup and hides the panel once all three steps are done", () => {
    const state = computeOnboardingState({
      ...baseInput,
      kindleEmailSet: true,
      senderConfirmed: true,
      testDeliverySucceeded: true
    });
    expect(state.setupComplete).toBe(true);
    expect(state.visible).toBe(false);
  });

  it("hides the panel when the user dismisses it even if setup is incomplete", () => {
    const state = computeOnboardingState({ ...baseInput, dismissed: true });
    expect(state.setupComplete).toBe(false);
    expect(state.visible).toBe(false);
  });

  it("stays visible when delivery is disabled so the user sees why setup can't finish", () => {
    const state = computeOnboardingState({
      ...baseInput,
      emailDeliveryEnabled: false,
      kindleEmailSet: true,
      senderConfirmed: true
    });
    expect(state.setupComplete).toBe(false);
    expect(state.visible).toBe(true);
  });
});

describe("hasSuccessfulDelivery", () => {
  it("returns false when there are no deliveries", () => {
    expect(hasSuccessfulDelivery([])).toBe(false);
  });

  it("returns false when all deliveries are pending or failed", () => {
    expect(hasSuccessfulDelivery([{ status: "pending" }, { status: "failed" }])).toBe(false);
  });

  it("returns true when at least one delivery has been sent", () => {
    expect(hasSuccessfulDelivery([{ status: "failed" }, { status: "sent" }])).toBe(true);
  });
});

describe("storage keys", () => {
  it("namespaces the dismissal and sender-confirmation flags per user", () => {
    expect(onboardingDismissedKey("user-1")).toBe("kindleflow:onboarding-dismissed:user-1");
    expect(onboardingSenderConfirmedKey("user-1")).toBe("kindleflow:onboarding-sender-confirmed:user-1");
    expect(onboardingDismissedKey("user-1")).not.toBe(onboardingDismissedKey("user-2"));
  });
});
