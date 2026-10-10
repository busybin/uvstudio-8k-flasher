# UV Studio — 8K overlay flasher

> A fork of [armel/uvstudio](https://armel.github.io/uvstudio/) (UV Studio by Armel FAUVEAU,
> Apache-2.0) repointed at **our own 8K overlay firmware and Apps**, so that everything a
> Quansheng UV-K1 / UV-K5 V3 owner needs is reachable from **one page** — no hunting for
> downloads.
>
> **Live page: <https://busybin.github.io/uvstudio-8k-flasher/>**

![8K overlay flasher — Apps tab](screenshots/flasher-apps.png)
![Prosigns editor](screenshots/flasher-prosigns.png)

## What this fork changes

| # | Change | Why |
| --- | --- | --- |
| 1 | Repository slimmed to the UV Studio tool (upstream's homepage/blog content removed) | this fork exists to publish the flasher |
| 2 | App install size gate `0x1000` → **`0x2000`** (8 KiB) + localised "8 KiB" strings | our firmware doubles the overlay App window |
| 3 | Firmware catalog → **`busybin/uv-k1-k5v3-firmware-f4hwn-8k`** (branch `v610-8k`) | the dropdown must offer the 8K firmware, not the stock one |
| 4 | App catalog → same repository (`archive/apps/v6.1.0/`) | the dropdown lists our Apps **and** the official ones |
| 5 | A banner in the Apps tab stating the 8K requirement | prevents installing 8K Apps on a stock radio |
| 6 | `.nojekyll` + GitHub Pages (branch `master`, root) | the page is served straight from this repository |

Everything else — display viewer, keypad, RF log, calibration backup/restore, boot logos,
firmware flashing, CHIRP driver offer — is upstream's code, untouched.

## Using the page

- **Desktop Chrome, Edge or ChromeOS only** (Web Serial API); the radio must be plugged into
  the machine running the browser. Firefox/Safari and phones are not supported.
- **Apps tab** → *Firmware version* `v6.1.0` → *Application*: pick our **CW** or **SECMSG**
  App (the starred entries) or any official app → *Target slot* → **Install app**. The catalog
  shows the real name and version from each package header.
- **Flash tab** → firmware dropdown: **F4HWN Labs v6.1.0** is our 8K build
  (`f4hwn.labs.8k.v6.1.0.bin`). Flashing it changes the App slot stride, so **re-install every
  App afterwards**.
- The CHIRP driver offer still resolves from upstream's releases for the matching version —
  that is intentional, the driver belongs to the upstream firmware version.

## ⚠️ Before installing anything

1. **Our Apps need the 8K firmware.** Installing an 8K App on the stock 4 KiB firmware makes
   it crash on start (its `.bss` overruns the stock overlay workspace). The firmware dropdown
   here is the 8K build.
2. After flashing the 8K firmware, **re-install all Apps** — the slot stride changed
   (`0x2000` → `0x3000`).
3. Unofficial builds of the official Apps are used on purpose: the `APRS RX`/`APRS TX`
   packages in the catalog carry a stack fix (upstream's freeze on entry under the 8K
   firmware's 704 B stack).

## Companion repositories

| Repository | Contents |
| --- | --- |
| [`busybin/uv-k1-k5v3-firmware-f4hwn-8k`](https://github.com/busybin/uv-k1-k5v3-firmware-f4hwn-8k) | the 8K overlay firmware (fork of `armel/uv-k1-k5v3-firmware-custom` v6.1.0) |
| [`busybin/F4HWN-CW-Morse-App`](https://github.com/busybin/F4HWN-CW-Morse-App) | CW (Morse) transceiver overlay App |
| [`busybin/F4HWN-Encrypted-Messenger-App`](https://github.com/busybin/F4HWN-Encrypted-Messenger-App) | encrypted messenger overlay App |

## Licence & attribution

Apache-2.0 (see [LICENSE](LICENSE)). UV Studio is © Armel FAUVEAU, derived from K5Viewer and
UVTools2 (see [NOTICE](NOTICE)); this fork publishes only the modifications listed above,
which are © busybin under the same licence. Forking and keeping forks open follows the
upstream authors' request in the firmware repository.

## Keeping the page current

The firmware and App dropdowns read this fork's own repository
(`busybin/uv-k1-k5v3-firmware-f4hwn-8k`, branch `v610-8k`, `archive/`), so publishing a new
build is: drop the new files into that repository's `archive/` and this page offers them —
no page edit needed.

When upstream UV Studio is synced into this fork, re-apply the six changes in the table
above (see the per-change commits in this repository's history — each one is a standalone
patch).
