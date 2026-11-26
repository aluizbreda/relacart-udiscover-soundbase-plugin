// Relacart U.Discover live USB adapter.
//
// HID acquisition is confirmed on Windows. The analyzer's active sweep range
// is currently read from its frame header; range/gain configuration commands
// are not yet sent by this plugin. SoundBase can select a software window
// inside the active scan and receive evenly spaced dBm points from it.

import { createRequire } from 'node:module';
import {
  SpectrumFrameAssembler,
  USB_IDENTITY,
} from './driver/protocol.js';

export const PRODUCT = 'plugin:relacart-udiscover/u-discover';

const require = createRequire(import.meta.url);
const SWEEP_PERIOD_MS = 4_000;
const FRAME_TIMEOUT_MS = 8_000;
const MAX_POINT_COUNT = 248;

function hidApi() {
  try {
    return require('node-hid');
  } catch (cause) {
    throw new Error(
      'Relacart U.Discover requires the node-hid dependency in the Windows plugin package.',
      { cause },
    );
  }
}

/** Discover attached U.Discover units without opening them. */
export async function discoverDevices() {
  if (process.platform !== 'win32') return [];

  let api;
  try {
    api = hidApi();
  } catch {
    return [];
  }

  return api.devices()
    .filter(
      (entry) =>
        entry.vendorId === USB_IDENTITY.vendorId &&
        entry.productId === USB_IDENTITY.productId &&
        entry.product === USB_IDENTITY.product &&
        entry.path,
    )
    .map((entry) => {
      const stableKey = entry.serialNumber || entry.path;
      return {
        id: `usb-hid:${encodeURIComponent(stableKey)}`,
        name: 'Relacart U.Discover',
        product: PRODUCT,
        transport: {
          kind: 'usb-hid',
          path: entry.path,
          vendorId: entry.vendorId,
          productId: entry.productId,
        },
      };
    });
}

export function createSpectrumAnalyzerAdapter(device) {
  return new RelacartSpectrumAdapter(device);
}

class RelacartSpectrumAdapter {
  constructor(device) {
    // The shell keeps `id`, product, and user config on the device object but
    // may omit the free-form discovery `transport` payload. Resolve the HID
    // path again from our stable id when that happens.
    this.deviceId = device?.id;
    this.path = device?.transport?.path ?? device?.config?.path ?? null;
    this.hid = null;
    this.Device = null;
    this.client = null;
    this.frame = null;
    this.effective = null;
    this.sweeping = false;
    this.onFatal = null;
  }

  async open() {
    if (process.platform !== 'win32') {
      throw new Error(
        'The U.Discover USB connection is available only to the Windows plugin runtime.',
      );
    }
    const api = hidApi();
    if (!this.path) this.path = findHidPath(api, this.deviceId);
    if (!this.path) {
      throw new Error('U.Discover was discovered, but its HID path could not be resolved.');
    }

    const Device = api.HID;
    if (typeof Device !== 'function') {
      throw new Error('The installed node-hid package has no HID device class.');
    }

    this.Device = Device;
    this.client = new RelacartHidClient(new Device(this.path));
    this.frame = await this.#requestFrameWithRecovery();

    const lower = this.frame.startHz;
    const upper = this.frame.stopHz;
    const measuredStepHz = medianStep(this.frame.points);

    return {
      capabilities: {
        minFrequencyHz: lower,
        maxFrequencyHz: upper,
        minStepHz: Math.max(1, Math.floor(measuredStepHz)),
        maxStepHz: Math.max(1, Math.ceil(this.frame.spanHz)),
      },
      identity: {
        manufacturer: 'Relacart',
        model: USB_IDENTITY.product,
      },
    };
  }

  /**
   * The unit's range-setting commands are not yet verified. For now, clamp to
   * the range currently active on the analyzer and use software cropping and
   * interpolation. Never claim that the hardware changed its scan settings.
   */
  async applyConfig(cfg = {}) {
    if (!this.frame) throw new Error('Open the U.Discover before configuring it.');

    const hardwareStartHz = this.frame.startHz;
    const hardwareStopHz = this.frame.stopHz;
    const previous = this.effective;

    let startHz = finite(cfg.startHz)
      ? cfg.startHz
      : (previous?.startHz ?? hardwareStartHz);
    let stopHz = finite(cfg.stopHz)
      ? cfg.stopHz
      : (previous?.stopHz ?? hardwareStopHz);

    startHz = clamp(startHz, hardwareStartHz, hardwareStopHz);
    stopHz = clamp(stopHz, hardwareStartHz, hardwareStopHz);
    if (stopHz <= startHz) {
      startHz = hardwareStartHz;
      stopHz = hardwareStopHz;
    }

    const requestedCount = finite(cfg.pointCount)
      ? Math.round(cfg.pointCount)
      : (previous?.pointCount ?? MAX_POINT_COUNT);
    const pointCount = clamp(requestedCount, 2, MAX_POINT_COUNT);

    this.effective = { startHz, stopHz, pointCount };
    return { ...this.effective, resolved: { sweepTimeMs: SWEEP_PERIOD_MS } };
  }

  async startSweep(onTrace) {
    if (this.sweeping) return;
    if (!this.client || !this.effective) {
      throw new Error('Open and configure the U.Discover before starting a scan.');
    }

    this.sweeping = true;
    void this.#sweepLoop(onTrace);
  }

  async #sweepLoop(onTrace) {
    while (this.sweeping) {
      const startedAt = Date.now();
      try {
        const frame = await this.#requestFrameWithRecovery();
        this.frame = frame;
        if (!this.sweeping) return;

        const trace = resample(
          frame.points,
          this.effective.startHz,
          this.effective.stopHz,
          this.effective.pointCount,
        );
        onTrace(trace);
      } catch (error) {
        if (!this.sweeping) return;
        this.sweeping = false;
        this.onFatal?.(error);
        return;
      }

      const remaining = SWEEP_PERIOD_MS - (Date.now() - startedAt);
      if (remaining > 0) await delay(remaining);
    }
  }

  async #requestFrameWithRecovery() {
    try {
      return await this.client.requestFrame();
    } catch (firstError) {
      if (!String(firstError?.message).includes('Timed out waiting for a U.Discover spectrum frame')) {
        throw firstError;
      }

      // A missed frame should not immediately mark the analyzer offline. Drop
      // the possibly stale HID handle and retry once with a fresh connection.
      try {
        this.client?.close();
      } catch {
        // Continue with a new handle; the old one has already failed its read.
      }

      await delay(250);
      try {
        this.client = new RelacartHidClient(new this.Device(this.path));
        return await this.client.requestFrame();
      } catch (retryError) {
        throw new Error(
          `U.Discover frame timed out; one HID reconnect/retry also failed. ` +
            `First attempt: ${firstError.message}. Retry: ${retryError.message}`,
          { cause: retryError },
        );
      }
    }
  }

  async stopSweep() {
    this.sweeping = false;
  }

  async close() {
    this.sweeping = false;
    this.client?.close();
    this.client = null;
    this.frame = null;
  }
}

function findHidPath(api, deviceId) {
  const match = /^usb-hid:(.+)$/.exec(deviceId ?? '');
  if (!match) return null;

  let stableKey;
  try {
    stableKey = decodeURIComponent(match[1]);
  } catch {
    return null;
  }

  return api.devices().find((entry) =>
    entry.vendorId === USB_IDENTITY.vendorId &&
    entry.productId === USB_IDENTITY.productId &&
    entry.product === USB_IDENTITY.product &&
    (entry.serialNumber || entry.path) === stableKey &&
    entry.path,
  )?.path ?? null;
}

class RelacartHidClient {
  constructor(device) {
    this.device = device;
    this.assembler = new SpectrumFrameAssembler();
    this.pending = null;
    this.requestInProgress = false;
    this.lastRequestAt = null;
    this.closed = false;

    this.device.on('data', this.#onData);
    this.device.on('error', this.#onError);
  }

  async requestFrame() {
    if (this.closed) throw new Error('U.Discover HID is closed.');
    if (this.requestInProgress || this.pending) {
      throw new Error('A U.Discover frame is already in progress.');
    }

    this.requestInProgress = true;
    try {
      // The unit transfers a frame for about 2.2 seconds and its app polls on
      // roughly a four-second cadence. Respect that cadence even when the host
      // asks for the first sweep immediately after open() fetched capabilities.
      if (this.lastRequestAt !== null) {
        const waitMs = SWEEP_PERIOD_MS - (Date.now() - this.lastRequestAt);
        if (waitMs > 0) await delay(waitMs);
      }
      if (this.closed) throw new Error('U.Discover HID is closed.');

      this.assembler.reset();
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const pending = this.pending;
          const details = pending
            ? ` (reports received: ${pending.reportCount}; last sequence: ` +
              `${pending.lastSequence ?? 'none'}; header acknowledged: ` +
              `${pending.headerAcknowledged})`
            : '';
          this.#settle(
            new Error(`Timed out waiting for a U.Discover spectrum frame${details}.`),
          );
        }, FRAME_TIMEOUT_MS);
        this.pending = {
          resolve,
          reject,
          timeout,
          headerAcknowledged: false,
          reportCount: 0,
          lastSequence: null,
        };
        this.lastRequestAt = Date.now();

        try {
          this.#send('%Z,25');
        } catch (error) {
          this.#settle(error);
        }
      });
    } finally {
      this.requestInProgress = false;
    }
  }

  #onData = (report) => {
    if (!this.pending) return;

    const packet = decodeAsRelacartPacket(report);
    if (packet?.command === '%Z') {
      this.pending.reportCount += 1;
      this.pending.lastSequence = packet.sequence;
    }

    const frame = this.assembler.push(report);
    if (!frame) {
      if (
        packet?.kind === 'header' &&
        packet.command === '%Z' &&
        !this.pending.headerAcknowledged
      ) {
        this.pending.headerAcknowledged = true;
        try {
          this.#send('%Y,01');
        } catch (error) {
          this.#settle(error);
        }
      }
      return;
    }

    this.#settle(null, frame);
  };

  #onError = (error) => {
    if (this.pending) this.#settle(error);
  };

  #send(command) {
    const body = `${command},`;
    const packet = `${body}${crc16(body)}#`;
    // The vendor bridge prepends HID report ID 0, then ASCII command bytes.
    const report = [0, ...Buffer.from(packet, 'ascii')];
    const written = this.device.write(report);
    if (!written) throw new Error(`The U.Discover rejected command ${command}.`);
  }

  #settle(error, frame = null) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timeout);
    if (error) pending.reject(error);
    else pending.resolve(frame);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.#settle(new Error('U.Discover connection closed.'));
    this.assembler.reset();
    this.device.removeListener('data', this.#onData);
    this.device.removeListener('error', this.#onError);
    this.device.close();
  }
}

// Decode only enough to detect the header and decide whether to send the ACK.
// The assembler remains the canonical parser for complete frames.
function decodeAsRelacartPacket(report) {
  const text = Array.from(report, (byte) => String.fromCharCode(byte))
    .join('')
    .replace(/^\0+|\0+$/g, '')
    .trim();
  const match = /^(%Z|%H),([0-9A-F]{2}),([0-9A-F]*),([0-9A-F]{4})#$/i.exec(text);
  if (!match) return null;
  const sequence = Number.parseInt(match[2], 16);
  return {
    kind: sequence === 0 ? 'header' : 'data',
    command: match[1].toUpperCase(),
    sequence,
  };
}

function crc16(text) {
  let crc = 0xffff;
  for (const byte of Buffer.from(text, 'ascii')) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc.toString(16).padStart(4, '0').toUpperCase();
}

function resample(points, startHz, stopHz, pointCount) {
  if (points.length < 2) throw new Error('The U.Discover returned too few points.');

  const output = new Array(pointCount);
  let right = 1;

  for (let index = 0; index < pointCount; index += 1) {
    const frequencyHz = startHz + (stopHz - startHz) * index / (pointCount - 1);
    while (right < points.length - 1 && points[right].frequencyHz < frequencyHz) {
      right += 1;
    }

    // The U.Discover reports narrow carriers as single-bin peaks. Linear
    // interpolation between adjacent bins can greatly reduce their displayed
    // level when the SoundBase grid is offset from the instrument's measured
    // frequency grid. Select the nearest acquired bin instead, preserving the
    // actual detector reading rather than inventing an intermediate level.
    const leftIndex = Math.max(0, right - 1);
    const leftDistance = Math.abs(points[leftIndex].frequencyHz - frequencyHz);
    const rightDistance = Math.abs(points[right].frequencyHz - frequencyHz);
    output[index] = points[leftDistance <= rightDistance ? leftIndex : right].levelDbm;
  }

  return output;
}

function medianStep(points) {
  const steps = [];
  for (let index = 1; index < points.length; index += 1) {
    const step = points[index].frequencyHz - points[index - 1].frequencyHz;
    if (step > 0) steps.push(step);
  }
  if (!steps.length) return 1;
  steps.sort((a, b) => a - b);
  return steps[Math.floor(steps.length / 2)];
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
