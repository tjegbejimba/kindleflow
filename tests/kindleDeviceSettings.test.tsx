import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { KindleDeviceList, KindleTargetPicker } from "../client/src/KindleDeviceSettings.js";
import {
  defaultKindleIds,
  deliveryToast,
  kindleSelectionForRequest,
  type KindleDeviceView
} from "../client/src/kindleDevices.js";

const paperwhite: KindleDeviceView = {
  id: "k1",
  name: "Paperwhite",
  email: "pw@kindle.com",
  sendByDefault: true,
  isPrimary: true
};
const scribe: KindleDeviceView = {
  id: "k2",
  name: "Scribe",
  email: "scribe@kindle.com",
  sendByDefault: false,
  isPrimary: false
};

function render(element: React.ReactElement): Document {
  return new JSDOM(renderToStaticMarkup(element)).window.document;
}

describe("kindle device helpers", () => {
  it("defaultKindleIds returns the send-by-default devices", () => {
    expect(defaultKindleIds([paperwhite, scribe])).toEqual(["k1"]);
  });

  it("only sends an explicit selection when the account has several Kindles", () => {
    expect(kindleSelectionForRequest([paperwhite], ["k1"])).toEqual({});
    expect(kindleSelectionForRequest([paperwhite, scribe], ["k2"])).toEqual({ kindles: ["k2"] });
  });

  it("summarizes single, full, partial, and failed deliveries", () => {
    expect(deliveryToast([{ status: "sent", kindleEmail: "pw@kindle.com" }], "EPUB")).toEqual({
      kind: "success",
      message: "EPUB sent to pw@kindle.com."
    });
    expect(
      deliveryToast(
        [
          { status: "sent", kindleEmail: "pw@kindle.com" },
          { status: "sent", kindleEmail: "scribe@kindle.com" }
        ],
        "EPUB"
      )
    ).toEqual({ kind: "success", message: "EPUB sent to 2 Kindles." });
    expect(
      deliveryToast(
        [
          { status: "sent", kindleEmail: "pw@kindle.com" },
          { status: "failed", kindleEmail: "scribe@kindle.com", error: "bounced" }
        ],
        "EPUB"
      )
    ).toEqual({ kind: "error", message: "EPUB sent to 1 of 2 Kindles. scribe@kindle.com failed: bounced" });
    expect(deliveryToast([{ status: "failed", kindleEmail: "pw@kindle.com", error: "smtp" }], "EPUB")).toEqual({
      kind: "error",
      message: "EPUB failed: smtp"
    });
    expect(deliveryToast([], "EPUB")).toBeNull();
  });
});

describe("KindleDeviceList", () => {
  it("lists each Kindle with its default toggle and a remove button", () => {
    const doc = render(
      <KindleDeviceList
        devices={[paperwhite, scribe]}
        isBusy={false}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onToggleDefault={vi.fn()}
      />
    );
    const rows = [...doc.querySelectorAll(".kindle-device")];
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(["Paperwhite", "Scribe"]);
    expect(rows[0].textContent).toContain("pw@kindle.com");
    const toggles = [...doc.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
    expect(toggles.map((toggle) => toggle.checked)).toEqual([true, false]);
    // The only default Kindle cannot be unchecked.
    expect(toggles[0].disabled).toBe(true);
    expect(doc.querySelectorAll("button.kindle-remove")).toHaveLength(2);
    expect(doc.querySelector("input[aria-label='New Kindle name']")).not.toBeNull();
    expect(doc.querySelector("input[aria-label='New Kindle email']")).not.toBeNull();
  });

  it("explains how to add a Kindle when none are configured", () => {
    const doc = render(
      <KindleDeviceList devices={[]} isBusy={false} onAdd={vi.fn()} onRemove={vi.fn()} onToggleDefault={vi.fn()} />
    );
    expect(doc.body.textContent).toContain("No Kindles yet");
  });
});

describe("KindleTargetPicker", () => {
  it("renders nothing with a single Kindle", () => {
    const markup = renderToStaticMarkup(
      <KindleTargetPicker idPrefix="t" devices={[paperwhite]} selectedIds={["k1"]} onChange={vi.fn()} disabled={false} />
    );
    expect(markup).toBe("");
  });

  it("renders a checkbox per Kindle with the selection checked", () => {
    const doc = render(
      <KindleTargetPicker
        idPrefix="t"
        devices={[paperwhite, scribe]}
        selectedIds={["k2"]}
        onChange={vi.fn()}
        disabled={false}
      />
    );
    expect(doc.querySelector("legend")?.textContent).toBe("Send to");
    const boxes = [...doc.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
    expect(boxes.map((box) => box.checked)).toEqual([false, true]);
  });
});
