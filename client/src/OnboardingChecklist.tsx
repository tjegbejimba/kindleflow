import React from "react";
import type { OnboardingState } from "./onboarding.js";

interface OnboardingChecklistProps {
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
  onDismiss: () => void;
}

export function OnboardingChecklist({
  state,
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
  isBusy,
  onDismiss
}: OnboardingChecklistProps): React.JSX.Element {
  const [emailComplete, senderComplete, testComplete] = state.steps.map((step) => step.complete);

  return (
    <section className="card onboarding" aria-label="First-time setup">
      <div className="onboarding-header">
        <div>
          <p className="eyebrow">Get started</p>
          <h2>Set up Kindle delivery</h2>
          <p className="muted">
            KindleFlow turns an article into an EPUB and emails it to your Kindle. Three quick steps and your first
            article will land on your device.
          </p>
        </div>
        <button type="button" className="secondary onboarding-dismiss" onClick={onDismiss}>
          Dismiss
        </button>
      </div>

      <p className="onboarding-progress" aria-live="polite">
        {state.completedCount} of {state.totalCount} steps done
      </p>

      {!emailDeliveryEnabled ? (
        <p className="muted warning">
          Email delivery is not configured on the server yet, so the test step can’t run. You can still set your Kindle
          email below; ask your administrator to configure SMTP to enable delivery.
        </p>
      ) : null}

      <ol className="onboarding-steps">
        <li className={emailComplete ? "onboarding-step done" : "onboarding-step"}>
          <span className="onboarding-step-marker" aria-hidden="true">
            {emailComplete ? "✓" : "1"}
          </span>
          <div className="onboarding-step-body">
            <h3>Set your Kindle email</h3>
            <p className="muted">
              Find this in Amazon under <em>Manage Your Content and Devices → Preferences → Personal Document Settings</em>
              . It looks like <code>name_123@kindle.com</code>.
            </p>
            <div className="input-row">
              <input
                type="email"
                aria-label="Kindle email address"
                placeholder="name_123@kindle.com"
                value={kindleEmail}
                onChange={(event) => onKindleEmailChange(event.target.value)}
              />
              <button type="button" onClick={onSaveKindleEmail} disabled={isBusy || !kindleEmail.trim()}>
                {savingEmail ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </li>

        <li className={senderComplete ? "onboarding-step done" : "onboarding-step"}>
          <span className="onboarding-step-marker" aria-hidden="true">
            {senderComplete ? "✓" : "2"}
          </span>
          <div className="onboarding-step-body">
            <h3>Approve the sender in Amazon</h3>
            <p className="muted">
              Add this address to your <em>Approved Personal Document E-mail List</em>, otherwise Amazon will reject the
              EPUB. Go to <em>Personal Document Settings → Approved Personal Document E-mail List → Add a new approved
              e-mail address</em>.
            </p>
            {kindleApprovedSender ? (
              <div className="sender-help">
                <p>
                  Approved sender to add: <code>{kindleApprovedSender}</code>
                </p>
                <div className="action-buttons">
                  <button type="button" className="secondary" onClick={onCopySender}>
                    Copy sender
                  </button>
                  <a className="button secondary-link" href={kindleSettingsUrl} target="_blank" rel="noreferrer">
                    Open Amazon Kindle settings
                  </a>
                </div>
              </div>
            ) : (
              <p className="muted warning">
                The server hasn’t set an SMTP sender address yet, so there’s nothing to approve. Ask your administrator
                to configure <code>SMTP_FROM</code>.
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
              I’ve added this sender to my approved list
            </label>
          </div>
        </li>

        <li className={testComplete ? "onboarding-step done" : "onboarding-step"}>
          <span className="onboarding-step-marker" aria-hidden="true">
            {testComplete ? "✓" : "3"}
          </span>
          <div className="onboarding-step-body">
            <h3>Send a test and verify</h3>
            <p className="muted">
              Send a test EPUB to confirm everything works. If it doesn’t arrive, double-check the approved sender in
              step 2.
            </p>
            <button
              type="button"
              onClick={onSendTest}
              disabled={isBusy || !emailDeliveryEnabled || !emailComplete}
            >
              {sendingTest ? "Sending test..." : "Send test EPUB"}
            </button>
            {!emailComplete ? <p className="muted">Set your Kindle email first.</p> : null}
          </div>
        </li>
      </ol>

      <div className="onboarding-next">
        <p className="eyebrow">After setup</p>
        <p className="muted">
          Paste an article URL above to send it, install the browser extension for paid Substack posts, add
          subscriptions to auto-deliver new posts, or use the OPDS link to sync with a reader app.
        </p>
      </div>
    </section>
  );
}
