import React from "react";

export interface GeneratedFileActionFile {
  filename: string;
  mimeType: "application/epub+zip" | "application/pdf";
  downloadUrl: string;
  sentToKindle: boolean;
}

interface GeneratedFileActionsProps {
  file: GeneratedFileActionFile;
  fileTypeLabel: string;
  canSendToKindle: boolean;
  isBusy: boolean;
  isExpanded: boolean;
  onExpandedChange: (isExpanded: boolean) => void;
  onSendToKindle: () => void;
  sendButtonLabel: string;
}

export function GeneratedFileActions({
  file,
  fileTypeLabel,
  canSendToKindle,
  isBusy,
  isExpanded,
  onExpandedChange,
  onSendToKindle,
  sendButtonLabel
}: GeneratedFileActionsProps): React.JSX.Element {
  return (
    <details
      className="card generated-file-actions"
      open={isExpanded}
      onToggle={(event) => onExpandedChange(event.currentTarget.open)}
    >
      <summary>
        <span className="generated-file-summary-copy">
          <span className="generated-file-title">Your {fileTypeLabel} is ready</span>
          <span className="muted">{file.filename}</span>
        </span>
        <span className="generated-file-toggle">{isExpanded ? "Hide actions" : "Show actions"}</span>
      </summary>
      <div className="generated-file-content">
        <div className="action-buttons">
          <a className="button" href={file.downloadUrl}>
            Download {fileTypeLabel}
          </a>
          {canSendToKindle ? (
            <button type="button" onClick={onSendToKindle} disabled={isBusy}>
              {sendButtonLabel}
            </button>
          ) : null}
        </div>
      </div>
    </details>
  );
}
