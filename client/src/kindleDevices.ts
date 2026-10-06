export interface KindleDeviceView {
  id: string;
  name: string;
  email: string;
  sendByDefault: boolean;
  isPrimary: boolean;
}

export interface DeliveryOutcome {
  status: "pending" | "sent" | "failed";
  kindleEmail?: string;
  error?: string;
}

export function defaultKindleIds(devices: KindleDeviceView[]): string[] {
  return devices.filter((device) => device.sendByDefault).map((device) => device.id);
}

/** With one Kindle the server's defaults are always right, so only send a selection when there is a choice. */
export function kindleSelectionForRequest(devices: KindleDeviceView[], selectedIds: string[]): { kindles?: string[] } {
  return devices.length > 1 ? { kindles: selectedIds } : {};
}

export function deliveryToast(
  deliveries: DeliveryOutcome[],
  action: string
): { kind: "success" | "error"; message: string } | null {
  const settled = deliveries.filter((delivery) => delivery.status !== "pending");
  if (settled.length === 0) return null;
  const sent = settled.filter((delivery) => delivery.status === "sent");
  const failed = settled.filter((delivery) => delivery.status === "failed");

  if (failed.length === 0) {
    const message =
      sent.length === 1 ? `${action} sent to ${sent[0].kindleEmail ?? "your Kindle"}.` : `${action} sent to ${sent.length} Kindles.`;
    return { kind: "success", message };
  }
  if (sent.length === 0) {
    const firstError = failed[0].error ?? "unknown error";
    return {
      kind: "error",
      message: failed.length === 1 ? `${action} failed: ${firstError}` : `${action} failed for all ${failed.length} Kindles: ${firstError}`
    };
  }
  const failures = failed
    .map((delivery) => `${delivery.kindleEmail ?? "Kindle"} failed: ${delivery.error ?? "unknown error"}`)
    .join("; ");
  return { kind: "error", message: `${action} sent to ${sent.length} of ${settled.length} Kindles. ${failures}` };
}
