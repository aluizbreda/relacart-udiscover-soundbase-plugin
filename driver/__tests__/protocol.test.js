import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SpectrumFrameAssembler } from '../protocol.js';

const capture = JSON.parse(
  readFileSync(new URL('../captures/udiscover-live-cycle.json', import.meta.url), 'utf8'),
);

test('reassembles the captured U.Discover frame into 248 ordered points', () => {
  const assembler = new SpectrumFrameAssembler();
  let frame = null;

  for (const packet of capture.packets) {
    frame = assembler.push(Buffer.from(packet.ascii, 'ascii'), Date.parse(packet.at)) ?? frame;
  }

  assert.ok(frame, 'the capture should contain a complete frame');
  assert.equal(frame.points.length, 248);
  assert.equal(frame.amplitudesDbm.length, 248);
  assert.ok(frame.startHz < frame.stopHz);
  assert.ok(frame.points.every((point, index, points) =>
    index === 0 || point.frequencyHz > points[index - 1].frequencyHz,
  ));
  assert.ok(frame.points.every((point) => Number.isFinite(point.levelDbm)));
});
