import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { OnboardingGate } from "../client/src/OnboardingGate.js";
import { computeOnboardingState } from "../client/src/onboarding.js";

describe("onboarding gate", () => {
  it("renders a full-screen setup gate for incomplete onboarding without a dismiss affordance", () => {
    const state = computeOnboardingState({
      emailDeliveryEnabled: true,
      kindleEmailSet: false,
      senderConfirmed: false,
      testDeliverySucceeded: false
    });

    const markup = renderToStaticMarkup(
      <OnboardingGate
        state={state}
        emailDeliveryEnabled={true}
        kindleApprovedSender="kindleflow@example.com"
        kindleSettingsUrl="https://www.amazon.com/hz/mycd/myx#/home/settings/payment"
        kindleEmail=""
        onKindleEmailChange={vi.fn()}
        onSaveKindleEmail={vi.fn()}
        savingEmail={false}
        senderConfirmed={false}
        onSenderConfirmedChange={vi.fn()}
        onCopySender={vi.fn()}
        onSendTest={vi.fn()}
        sendingTest={false}
        isBusy={false}
      />
    );
    const dom = new JSDOM(markup);

    const gate = dom.window.document.querySelector("[aria-label='Required Kindle delivery setup']");
    expect(gate?.className).toContain("onboarding-gate");
    expect(gate?.textContent).toContain("Get articles onto your Kindle in three guided steps.");
    expect(gate?.textContent).toContain("Step 1 of 3");
    expect(gate?.textContent).toContain("Set your Kindle email");
    expect(gate?.textContent).not.toContain("Dismiss");
  });

  it("focuses the first incomplete step instead of repeating completed setup work", () => {
    const state = computeOnboardingState({
      emailDeliveryEnabled: true,
      kindleEmailSet: true,
      senderConfirmed: false,
      testDeliverySucceeded: false
    });

    const markup = renderToStaticMarkup(
      <OnboardingGate
        state={state}
        emailDeliveryEnabled={true}
        kindleApprovedSender="kindleflow@example.com"
        kindleSettingsUrl="https://www.amazon.com/hz/mycd/myx#/home/settings/payment"
        kindleEmail="tj@kindle.com"
        onKindleEmailChange={vi.fn()}
        onSaveKindleEmail={vi.fn()}
        savingEmail={false}
        senderConfirmed={false}
        onSenderConfirmedChange={vi.fn()}
        onCopySender={vi.fn()}
        onSendTest={vi.fn()}
        sendingTest={false}
        isBusy={false}
      />
    );

    expect(new JSDOM(markup).window.document.body.textContent).toContain("Step 2 of 3");
    expect(new JSDOM(markup).window.document.body.textContent).toContain("Approve the sender in Amazon");
  });

  it("keeps Kindle email editable after the email step is complete", () => {
    const state = computeOnboardingState({
      emailDeliveryEnabled: true,
      kindleEmailSet: true,
      senderConfirmed: false,
      testDeliverySucceeded: false
    });

    const markup = renderToStaticMarkup(
      <OnboardingGate
        state={state}
        emailDeliveryEnabled={true}
        kindleApprovedSender="kindleflow@example.com"
        kindleSettingsUrl="https://www.amazon.com/hz/mycd/myx#/home/settings/payment"
        kindleEmail="wrong@kindle.com"
        onKindleEmailChange={vi.fn()}
        onSaveKindleEmail={vi.fn()}
        savingEmail={false}
        senderConfirmed={false}
        onSenderConfirmedChange={vi.fn()}
        onCopySender={vi.fn()}
        onSendTest={vi.fn()}
        sendingTest={false}
        isBusy={false}
      />
    );
    const dom = new JSDOM(markup);

    expect(dom.window.document.body.textContent).toContain("Change Kindle email");
    expect(dom.window.document.querySelector("input[value='wrong@kindle.com']")).not.toBeNull();
  });

  it("renders status and error feedback inside the full-screen gate", () => {
    const state = computeOnboardingState({
      emailDeliveryEnabled: true,
      kindleEmailSet: false,
      senderConfirmed: false,
      testDeliverySucceeded: false
    });

    const markup = renderToStaticMarkup(
      <OnboardingGate
        state={state}
        emailDeliveryEnabled={true}
        kindleApprovedSender="kindleflow@example.com"
        kindleSettingsUrl="https://www.amazon.com/hz/mycd/myx#/home/settings/payment"
        kindleEmail=""
        onKindleEmailChange={vi.fn()}
        onSaveKindleEmail={vi.fn()}
        savingEmail={false}
        senderConfirmed={false}
        onSenderConfirmedChange={vi.fn()}
        onCopySender={vi.fn()}
        onSendTest={vi.fn()}
        sendingTest={false}
        isBusy={false}
        status="Saving profile..."
        error="Kindle email failed."
      />
    );
    const dom = new JSDOM(markup);

    expect(dom.window.document.querySelector(".status")?.textContent).toBe("Saving profile...");
    expect(dom.window.document.querySelector(".error")?.textContent).toBe("Kindle email failed.");
  });
});
