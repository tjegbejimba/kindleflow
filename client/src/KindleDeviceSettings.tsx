import React from "react";
import type { KindleDeviceView } from "./kindleDevices.js";

interface KindleDeviceListProps {
  devices: KindleDeviceView[];
  isBusy: boolean;
  onAdd: (name: string, email: string) => Promise<boolean> | boolean;
  onRemove: (device: KindleDeviceView) => void;
  onToggleDefault: (device: KindleDeviceView, sendByDefault: boolean) => void;
}

export function KindleDeviceList({ devices, isBusy, onAdd, onRemove, onToggleDefault }: KindleDeviceListProps) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const defaultCount = devices.filter((device) => device.sendByDefault).length;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (await onAdd(name.trim(), email.trim())) {
      setName("");
      setEmail("");
    }
  }

  return (
    <div className="kindle-devices">
      {devices.length > 0 ? (
        <ul className="kindle-device-list">
          {devices.map((device) => {
            const isOnlyDefault = device.sendByDefault && defaultCount === 1;
            return (
              <li className="kindle-device" key={device.id}>
                <div className="kindle-device-copy">
                  <strong>{device.name}</strong>
                  <span>{device.email}</span>
                </div>
                <label
                  className="checkbox-row kindle-default-toggle"
                  title={isOnlyDefault ? "At least one Kindle must receive automatic sends." : undefined}
                >
                  <input
                    type="checkbox"
                    aria-label={`Send to ${device.name} automatically`}
                    checked={device.sendByDefault}
                    disabled={isBusy || isOnlyDefault}
                    onChange={(event) => onToggleDefault(device, event.target.checked)}
                  />
                  Auto-send
                </label>
                <button
                  type="button"
                  className="secondary kindle-remove"
                  aria-label={`Remove ${device.name}`}
                  onClick={() => onRemove(device)}
                  disabled={isBusy}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">No Kindles yet. Add your Send-to-Kindle address below.</p>
      )}
      <form className="kindle-add-form" onSubmit={submit}>
        <input
          type="text"
          aria-label="New Kindle name"
          placeholder="Name (e.g. Paperwhite)"
          maxLength={60}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <input
          type="email"
          aria-label="New Kindle email"
          placeholder="name_123@kindle.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <button type="submit" disabled={isBusy || !email.trim()}>
          Add Kindle
        </button>
      </form>
    </div>
  );
}

interface KindleTargetPickerProps {
  idPrefix: string;
  devices: KindleDeviceView[];
  selectedIds: string[];
  onChange: (selectedIds: string[]) => void;
  disabled: boolean;
}

export function KindleTargetPicker({ idPrefix, devices, selectedIds, onChange, disabled }: KindleTargetPickerProps) {
  if (devices.length <= 1) return null;

  function toggle(id: string, checked: boolean) {
    const next = new Set(selectedIds);
    if (checked) next.add(id);
    else next.delete(id);
    onChange(devices.filter((device) => next.has(device.id)).map((device) => device.id));
  }

  return (
    <fieldset className="kindle-target-picker">
      <legend>Send to</legend>
      {devices.map((device) => (
        <label className="checkbox-row" key={device.id} htmlFor={`${idPrefix}-${device.id}`}>
          <input
            id={`${idPrefix}-${device.id}`}
            type="checkbox"
            checked={selectedIds.includes(device.id)}
            disabled={disabled}
            onChange={(event) => toggle(device.id, event.target.checked)}
          />
          {device.name}
        </label>
      ))}
    </fieldset>
  );
}
