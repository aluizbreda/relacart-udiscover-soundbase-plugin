/**
 * Decoder for the U.Discover USB HID spectrum stream.
 *
 * The vendor UI receives ASCII packets in fixed-size HID reports. A %Z,00
 * packet begins a frame; %Z,01 through %Z,24 carry seven frequency/level
 * records each. The vendor UI removes the last four records from the final
 * packet before displaying/exporting the 248-point trace.
 */

export const USB_IDENTITY = Object.freeze({
  vendorId: 0x0f8b,
  productId: 0x0051,
  product: 'U.Discover',
});

export const PACKET_COUNT = 0x24;
export const POINTS_PER_PACKET = 7;
export const TRAILING_PADDING_POINTS = 4;

/** Convert an HID input report to a parsed Relacart packet. */
export function decodeReport(report) {
  const text = Array.from(report, (byte) => String.fromCharCode(byte))
    .join('')
    .replace(/^\0+|\0+$/g, '')
    .trim();

  const match = /^(%Z|%H),([0-9A-F]{2}),([0-9A-F]*),([0-9A-F]{4})#$/i.exec(text);
  if (!match) return null;

  const [, command, sequenceHex, payload, checksum] = match;
  const sequence = Number.parseInt(sequenceHex, 16);

  if (sequence === 0) {
    if (payload.length < 16) return null;
    return {
      kind: 'header',
      command,
      sequence,
      spanHz: Number.parseInt(payload.slice(0, 5), 16) * 1_000,
      centerHz: Number.parseInt(payload.slice(5, 10), 16) * 1_000,
      topDbm: 11 - Number.parseInt(payload.slice(10, 12), 16),
      maxValue: Number.parseInt(payload.slice(12, 14), 16),
      cleanValue: Number.parseInt(payload.slice(14, 16), 16),
      checksum,
      raw: text,
    };
  }

  if (payload.length === 0 || payload.length % 7 !== 0) return null;

  const points = [];
  for (let offset = 0; offset < payload.length; offset += 7) {
    points.push({
      frequencyHz: Number.parseInt(payload.slice(offset, offset + 5), 16) * 1_000,
      levelDbm: Number.parseInt(payload.slice(offset + 5, offset + 7), 16) - 110,
    });
  }

  return {
    kind: 'points',
    command,
    sequence,
    points,
    checksum,
    raw: text,
  };
}

/** Reassemble the vendor's 37-packet frame into the 248-point live trace. */
export class SpectrumFrameAssembler {
  #frame = null;

  push(report, capturedAt = Date.now()) {
    const packet = decodeReport(report);
    if (!packet || packet.command !== '%Z') return null;

    if (packet.kind === 'header') {
      this.#frame = {
        header: packet,
        points: [],
        nextSequence: 1,
        startedAt: capturedAt,
      };
      return null;
    }

    const frame = this.#frame;
    if (!frame) return null;

    if (packet.sequence !== frame.nextSequence || packet.sequence > PACKET_COUNT) {
      this.#frame = null;
      return null;
    }

    frame.points.push(...packet.points);
    frame.nextSequence += 1;

    if (packet.sequence !== PACKET_COUNT) return null;

    // This mirrors the vendor UI: its final packet contains four padding or
    // non-display records, removed before a scan is presented/exported.
    frame.points.splice(-TRAILING_PADDING_POINTS);
    this.#frame = null;

    const { header, points } = frame;
    const nominalStartHz = header.centerHz - header.spanHz / 2;
    const nominalStopHz = header.centerHz + header.spanHz / 2;
    const startHz = points[0]?.frequencyHz ?? nominalStartHz;
    const stopHz = points.at(-1)?.frequencyHz ?? nominalStopHz;

    return {
      startedAt: frame.startedAt,
      completedAt: capturedAt,
      startHz,
      stopHz,
      nominalStartHz,
      nominalStopHz,
      centerHz: header.centerHz,
      spanHz: header.spanHz,
      topDbm: header.topDbm,
      points,
      amplitudesDbm: points.map(({ levelDbm }) => levelDbm),
    };
  }

  reset() {
    this.#frame = null;
  }
}
