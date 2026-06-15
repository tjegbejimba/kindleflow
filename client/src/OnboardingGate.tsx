import React from "react";
import type { OnboardingState, OnboardingStepId } from "./onboarding.js";

interface OnboardingGateProps {
  state: OnboardingState;
  emailDeliveryEnabled: boolean;
  kindleApprovedSender?: string;
  kindleSettingsUrl: string;
  kindleEmail: string;
  onKindleEmailChange: (value: string) => void;
  onSaveKindleEmail: () => void;
  savingEmail: boolean;
  senderConfirmed: boolean;
  onSenderConfirmedChange: (confirmed: boolean) => void;
  onCopySender: () => void;
  onSendTest: () => void;
  sendingTest: boolean;
  isBusy: boolean;
  status?: string;
  error?: string;
}

const stepCopy: Record<OnboardingStepId, { title: string; shortTitle: string; body: string }> = {
  "kindle-email": {
    title: "Set your Kindle email",
    shortTitle: "Kindle email",
    body: "Tell KindleFlow where to deliver generated EPUBs and PDFs."
  },
  "approve-sender": {
    title: "Approve the sender in Amazon",
    shortTitle: "Approve sender",
    body: "Amazon only accepts documents from addresses on your approved sender list."
  },
  "send-test": {
    title: "Send a test and verify",
    shortTitle: "Test delivery",
    body: "Confirm Gmail and Amazon both accept the delivery before using the app."
  }
};

export function OnboardingGate(props: OnboardingGateProps): React.JSX.Element {
  const activeStep = firstIncompleteStep(props.state);

  return (
    <section className="onboarding-gate" aria-label="Required Kindle delivery setup">
      <div className="onboarding-gate-shell">
        <aside className="onboarding-gate-story">
          <p className="eyebrow">Welcome to KindleFlow</p>
          <h1>Get articles onto your Kindle in three guided steps.</h1>
          <p>
            KindleFlow turns articles, PDFs, and subscriptions into Kindle-ready deliveries. Finish setup once, then the
            rest of the app unlocks.
          </p>
          <ProgressMeter state={props.state} />
        </aside>
        <div className="onboarding-gate-card" aria-live="polite">
          {props.status ? <p className="status">{props.status}</p> : null}
          {props.error ? <p className="error">{props.error}</p> : null}
          <StepRail state={props.state} activeStep={activeStep} />
          <div className="onboarding-gate-step-detail">
            <p className="eyebrow">Step {stepNumber(activeStep)} of 3</p>
            <h2>{stepCopy[activeStep].title}</h2>
            <p className="muted">{stepCopy[activeStep].body}</p>
            <StepAction {...props} stepId={activeStep} />
          </div>
          <button type="button" disabled={!props.state.setupComplete} className="onboarding-gate-finish">
            Continue to KindleFlow
          </button>
        </div>
      </div>
    </section>
  );
}

type StepActionProps = OnboardingGateProps & { stepId: OnboardingStepId };

function StepAction({
  stepId,
  emailDeliveryEnabled,
  kindleApprovedSender,
  kindleSettingsUrl,
  kindleEmail,
  onKindleEmailChange,
  onSaveKindleEmail,
  savingEmail,
  senderConfirmed,
  onSenderConfirmedChange,
  onCopySender,
  onSendTest,
  sendingTest,
  isBusy
}: StepActionProps): React.JSX.Element {
  if (stepId === "kindle-email") {
    return (
      <div className="onboarding-gate-action">
        <label htmlFor="onboarding-kindle-email">Kindle email address</label>
        <div className="input-row">
          <input
            id="onboarding-kindle-email"
            type="email"
            aria-label="Kindle email address"
            placeholder="name_123@kindle.com"
            value={kindleEmail}
            onChange={(event) => onKindleEmailChange(event.target.value)}
          />
          <button type="button" onClick={onSaveKindleEmail} disabled={isBusy || !kindleEmail.trim()}>
            {savingEmail ? "Saving..." : "Save email"}
          </button>
        </div>
        <p className="muted">
          Find this in Amazon under <em>Manage Your Content and Devices - Preferences - Personal Document Settings</em>.
        </p>
      </div>
    );
  }

  if (stepId === "approve-sender") {
    return (
      <div className="onboarding-gate-action">
        {kindleApprovedSender ? (
          <>
            <p className="onboarding-gate-sender">
              Add <code>{kindleApprovedSender}</code> to Amazon's approved personal document sender list.
            </p>
            <div className="action-buttons">
              <button type="button" className="secondary" onClick={onCopySender}>
                Copy sender
              </button>
              <a className="button secondary-link" href={kindleSettingsUrl} target="_blank" rel="noreferrer">
                Open Amazon settings
              </a>
            </div>
          </>
        ) : (
          <p className="muted warning">
            The server has not set an SMTP sender address yet. Ask your administrator to configure <code>SMTP_FROM</code>.
          </p>
        )}
        <label className="checkbox-row">
          <input
            type="checkbox"
            aria-label="I've added this sender to my approved list"
            checked={senderConfirmed}
            onChange={(event) => onSenderConfirmedChange(event.target.checked)}
            disabled={!kindleApprovedSender}
          />
          I've added this sender to my approved list
        </label>
        <ChangeKindleEmail
          kindleEmail={kindleEmail}
          onKindleEmailChange={onKindleEmailChange}
          onSaveKindleEmail={onSaveKindleEmail}
          savingEmail={savingEmail}
          isBusy={isBusy}
        />
      </div>
    );
  }

  return (
    <div className="onboarding-gate-action">
      {!emailDeliveryEnabled ? (
        <p className="muted warning">
          Email delivery is not configured on the server yet, so this step cannot run. Ask your administrator to configure
          SMTP before KindleFlow can unlock.
        </p>
      ) : null}
      <button type="button" onClick={onSendTest} disabled={isBusy || !emailDeliveryEnabled || !kindleEmail.trim()}>
        {sendingTest ? "Sending test..." : "Send test EPUB"}
      </button>
      {!kindleEmail.trim() ? <p className="muted">Set your Kindle email first.</p> : null}
      {kindleEmail.trim() ? (
        <ChangeKindleEmail
          kindleEmail={kindleEmail}
          onKindleEmailChange={onKindleEmailChange}
          onSaveKindleEmail={onSaveKindleEmail}
          savingEmail={savingEmail}
          isBusy={isBusy}
        />
      ) : null}
    </div>
  );
}

function ChangeKindleEmail({
  kindleEmail,
  onKindleEmailChange,
  onSaveKindleEmail,
  savingEmail,
  isBusy
}: Pick<OnboardingGateProps, "kindleEmail" | "onKindleEmailChange" | "onSaveKindleEmail" | "savingEmail" | "isBusy">): React.JSX.Element {
  return (
    <div className="onboarding-gate-email-edit">
      <label htmlFor="onboarding-change-kindle-email">Change Kindle email</label>
      <div className="input-row">
        <input
          id="onboarding-change-kindle-email"
          type="email"
          aria-label="Change Kindle email"
          placeholder="name_123@kindle.com"
          value={kindleEmail}
          onChange={(event) => onKindleEmailChange(event.target.value)}
        />
        <button type="button" className="secondary" onClick={onSaveKindleEmail} disabled={isBusy || !kindleEmail.trim()}>
          {savingEmail ? "Saving..." : "Save change"}
        </button>
      </div>
    </div>
  );
}

function StepRail({ state, activeStep }: { state: OnboardingState; activeStep: OnboardingStepId }): React.JSX.Element {
  return (
    <ol className="onboarding-gate-steps">
      {state.steps.map((step, index) => (
        <li className={`${step.complete ? "done" : ""} ${step.id === activeStep ? "active" : ""}`} key={step.id}>
          <span>{step.complete ? "✓" : index + 1}</span>
          <strong>{stepCopy[step.id].shortTitle}</strong>
        </li>
      ))}
    </ol>
  );
}

function ProgressMeter({ state }: { state: OnboardingState }): React.JSX.Element {
  const percentage = Math.round((state.completedCount / state.totalCount) * 100);

  return (
    <div className="onboarding-gate-progress">
      <div>
        <span>
          {state.completedCount} of {state.totalCount} complete
        </span>
        <span>{percentage}%</span>
      </div>
      <meter min="0" max={state.totalCount} value={state.completedCount} />
    </div>
  );
}

function firstIncompleteStep(state: OnboardingState): OnboardingStepId {
  return state.steps.find((step) => !step.complete)?.id ?? "send-test";
}

function stepNumber(stepId: OnboardingStepId): number {
  return stepId === "kindle-email" ? 1 : stepId === "approve-sender" ? 2 : 3;
}
