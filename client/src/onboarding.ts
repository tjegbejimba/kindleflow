export type OnboardingStepId = "kindle-email" | "approve-sender" | "send-test";

export interface OnboardingStepState {
  id: OnboardingStepId;
  complete: boolean;
}

export interface OnboardingInput {
  emailDeliveryEnabled: boolean;
  kindleEmailSet: boolean;
  senderConfirmed: boolean;
  testDeliverySucceeded: boolean;
  dismissed: boolean;
}

export interface OnboardingState {
  steps: OnboardingStepState[];
  completedCount: number;
  totalCount: number;
  setupComplete: boolean;
  visible: boolean;
}

/**
 * Derives the first-time setup checklist state from existing config/user data.
 *
 * The three setup steps a new user must complete are: set a Kindle email,
 * approve the SMTP sender in Amazon, and confirm delivery works via a test
 * EPUB. Setup is "complete" once all three are done. The panel stays visible
 * until setup is complete or the user dismisses it. When delivery is not
 * configured server-side, the panel still renders (so the user understands
 * why) but setup can never complete on its own.
 */
export function computeOnboardingState(input: OnboardingInput): OnboardingState {
  const steps: OnboardingStepState[] = [
    { id: "kindle-email", complete: input.kindleEmailSet },
    { id: "approve-sender", complete: input.senderConfirmed },
    { id: "send-test", complete: input.testDeliverySucceeded }
  ];

  const completedCount = steps.filter((step) => step.complete).length;
  const totalCount = steps.length;
  const setupComplete = completedCount === totalCount;
  const visible = !input.dismissed && !setupComplete;

  return { steps, completedCount, totalCount, setupComplete, visible };
}

interface DeliveryLike {
  status: "pending" | "sent" | "failed";
}

/**
 * Treat any successfully sent delivery as proof the end-to-end pipeline
 * (SMTP + Amazon approved sender) works, which completes the "send a test"
 * onboarding step.
 */
export function hasSuccessfulDelivery(deliveries: readonly DeliveryLike[]): boolean {
  return deliveries.some((delivery) => delivery.status === "sent");
}

/** localStorage key for the per-user onboarding dismissal flag. */
export function onboardingDismissedKey(userId: string): string {
  return `kindleflow:onboarding-dismissed:${userId}`;
}

/** localStorage key for the per-user "I approved the sender" confirmation. */
export function onboardingSenderConfirmedKey(userId: string): string {
  return `kindleflow:onboarding-sender-confirmed:${userId}`;
}
