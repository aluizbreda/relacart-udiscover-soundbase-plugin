# Relacart U.Discover for SoundBase

SoundBase plugin for using the Relacart U.Discover as a live spectrum analyzer
in SoundBase Desktop.

## Status

The plugin discovers the U.Discover over USB HID and streams live spectrum
traces to SoundBase. It has been exercised in SoundBase Desktop on Windows 11
and its `doctor`, automated tests, and smoke check pass.

The U.Discover CSV already imports into SoundBase using its built-in
`Relacart UDiscover (*.csv)` scan type. This plugin is only for direct,
continuously updating scans.

## What we know so far

- The device is HID VID `0x0F8B`, PID `0x0051`, product string `U.Discover`.
  The vendor app uses `hidapi.dll`/`nextHID.dll` and receives a live ASCII
  spectrum stream over HID.
- Each complete `%Z` frame consists of one configuration header plus 36 data
  reports. After dropping the final four padded records, the UI shows 248
  points. Each point contains frequency in kHz and level converted to dBm by
  subtracting 110 from the level byte.
- The exported CSV is frequency in MHz and amplitude in dBm. It is a saved-scan
  format and does not describe the live USB messages.
- SoundBase settings can crop the range in software. The device's hardware
  range is still selected on the U.Discover itself.

## Current limitations and next step

The plugin does not change the U.Discover's hardware range or gain. Set the
hardware range on the analyzer before starting Live Scan. SoundBase's Average
and Max Hold modes can smooth or retain peaks across sweeps. The adapter
requires Windows and a direct USB connection to the computer running SoundBase.
See [`driver/PROTOCOL-NOTES.md`](driver/PROTOCOL-NOTES.md) and the saved
[`live HID frame`](driver/captures/udiscover-live-cycle.json).

## Development requirements

The plugin requires Node.js 20 or newer. For local development, load it in
SoundBase Desktop using `SB_PLUGIN_DIRS`. The plugin must run in the same
Windows environment that owns the USB connection.

## License

This plugin is distributed under the MIT License. See [`LICENSE`](LICENSE).
