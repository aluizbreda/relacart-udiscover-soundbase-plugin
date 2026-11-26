# U.Discover live USB protocol: investigation notes

## Confirmed from the installed app and a live capture

- The installed U-Discover 1.1.3 app is an x64 Windows executable using a
  WebView2 UI and native bridge. `config.json` names `hidapi.dll` as an
  essential DLL.
- Its `htdocs/interact/ClassHID.js` calls native procedures `lshid`,
  `openhid`, `loop_read`, `writehid`, and `closehid`. On attach, the app looks
  for the HID product string `U.Discover` and opens it for continuous reads.
- The installed app bundle includes `ext/hidapi.dll` and
  `npcextension/nextHID.dll`. The UI also has a UDP discovery/control path on
  port 39020; this is separate from the confirmed USB HID path.
- The JavaScript bundle reveals vendor command framing for USB: comma-separated
  ASCII fields, CRC appended, then `#`. Visible commands include `%A`, `%B`,
  `%C`, `%D`, `%L`, `%Z`, and `%Y`. The app polls with `%Z,25`; on a `%Z,00`
  header it sends `%Y,01`, after which the point packets arrive. This sequence
  has now been reproduced directly through `node-hid` with the vendor app
  closed.
- For `%Z`/`%H` replies, the UI treats `n[2]` as repeated 7-character records:
  five hexadecimal characters parsed as frequency and two as level; it plots
  the level after subtracting 110. The last-segment marker is `25`. The UI
  also contains a separate 430-point parser for an `AA55`-prefixed message,
  which appears tied to the network path. Do not assume the two transports use
  identical framing.
- Device identity: VID `0x0F8B`, PID `0x0051`, product string `U.Discover`,
  manufacturer string `GigaDevice`, interface 0, usage page `0x008C`, usage 1.
  Device Manager showed `HID\\VID_0F8B&PID_0051&REV_0100` and
  `HID\\VID_0F8B&PID_0051` while connected.
- `node-hid` in the Windows 11 ARM VM (x64 Node under emulation) opened the
  device and requested a full scan with the vendor app closed. The device
  returned reports `00` through `24`, allowing the probe to reconstruct all
  248 points. Reports arrive as ASCII text padded with NUL bytes; each report
  is 64 bytes.
- A complete `%Z` frame starts with sequence `00`, which carries:
  - 5 hex characters: sweep span in kHz;
  - 5 hex characters: center frequency in kHz;
  - 2 hex characters: top display level, decoded by the vendor UI as
    `11 - value` dBm;
  - 2 hex characters each for the `MAXValue` and `cleanValue` controls.
- Sequences `01` through `24` each contain seven 7-character records. Each
  record is 5 hex characters of frequency in kHz, followed by 2 hex characters
  of level; the vendor UI converts level to dBm as `value - 110`.
- The vendor UI drops the final four records in packet `24`. A full captured
  frame therefore yields 248 points. In the user's 470–698 MHz scan, the
  header reported 228 MHz span centered at 584 MHz, and the point frequencies
  covered 470.229–696.710 MHz. The frame took about 2.2 seconds to transfer;
  the vendor app polls for a new frame roughly every 4 seconds.
- `driver/captures/udiscover-live-cycle.json` preserves one sanitized raw
  frame. The capture contains no device serial number.
- Incoming packet suffixes are retained as four hex characters. The vendor UI
  does not validate them; their checksum semantics remain unknown.

## Still to confirm before a SoundBase release

- Commands/fields for setting requested start/stop frequencies, gain, and
  sweep mode. The adapter deliberately scans the hardware's current range and
  uses software crop/resampling until those controls are confirmed.
- Whether the SoundBase Windows desktop can load this native HID dependency in
  the Windows 11 ARM VM. The Node HID probe can enumerate and read the unit.
- Whether the measured frequency grid should be mapped to SoundBase's evenly
  spaced trace axis or supplied as the device's 248-point sequence.

## Next integration step

Load the plugin in SoundBase Desktop inside the Windows VM with the U.Discover
assigned to that VM. Confirm discovery, opening, and repeated live traces. Do
not send range/gain configuration commands until their vendor UI mappings are
confirmed.

## Implementation rule

The input protocol and direct read commands are confirmed, and the adapter
implements that read-only live path. Keep hardware range/gain controls out of
the adapter until their command mapping is verified.
