# The Toolroll iPhone app

The Toolroll iPhone app keeps an eye on your Toolroll from your pocket. It shows what needs you, lets you read plans,
steps and changes (diffs included), and lets you watch agents work live. It is read-only on purpose: approving a plan,
accepting a result and every other decision still happen on your Mac. When a screen asks for a decision, Handoff
offers that exact page in Toolroll on your Mac.

Notifications aren't built yet. Open the app to check what needs you.

## Getting the app

**The iPhone app isn't on the App Store yet.** Until it is, you build it from this repository and install it on your
own iPhone with Xcode.

You need:

- a Mac with Xcode 16 or later (the app is Swift 6);
- an iPhone on iOS 17 or later, and its USB cable (or the same Wi-Fi, once the phone is paired with Xcode);
- an Apple Account signed in to Xcode (Xcode → Settings → Accounts). A free account works. Apps signed with a free
  account stop opening after 7 days; build and run again to renew. A paid Apple Developer account lasts a year.

Steps:

1. Open `ios/ToolrollCompanion.xcodeproj` in Xcode.
2. Select the **ToolrollCompanion** target, open **Signing & Capabilities**, and choose your own **Team**.
3. Change the **Bundle Identifier** to one of your own, for example `com.example.toolroll`. The checked-in identifier
   belongs to the project's own team, so Xcode can't sign it for you.
4. If Xcode says your account can't use a capability listed there, remove that capability. The app doesn't need any
   capability beyond signing.
5. Connect your iPhone and pick it as the run destination. The first time, turn on Developer Mode on the iPhone
   (Settings → Privacy & Security → Developer Mode) and restart it when asked.
6. Press Run. If the iPhone says the developer isn't trusted, open Settings → General → VPN & Device Management, tap
   your Apple Account and choose Trust.

## Pairing

1. On your Mac, open Toolroll → **Settings → Phone**. An instance operator turns on phone access there (with their
   Toolroll password). Pairing needs a Toolroll password: an account without one is asked to set one first.
2. Choose **Pair an iPhone** and enter your password. The page shows a QR code that works once, for 5 minutes.
3. In the app, tap **Pair with your Mac** and scan the code. Give the phone a name you'll recognise.
4. The Mac's page switches by itself to a short code. Check that the iPhone shows exactly the same code, then click
   **Codes match — pair** on the Mac. If the codes differ, click Cancel: someone else scanned your QR code.
5. The page says "Finishing on the iPhone…" and then that your iPhone is paired.

Settings → Phone lists your phones with when each was paired and last connected. You can rename a phone there, and
**Remove** takes effect at once. Changing your password signs your phones out; pair them again. A Mac holds at most 32
phones.

## How the phone reaches your Mac

The phone always tries the direct way first.

**Directly, with no relay.** Toolroll listens for phones on port 4199 (or the next free port up to 4209; set
`TOOLROLL_PHONE_PORT` to choose another). A phone on the same Wi-Fi connects straight to the Mac's local address. With
[Tailscale](https://tailscale.com/download) on both the Mac and the iPhone, the phone connects directly from anywhere
through the Mac's Tailscale address. Settings → Phone shows each address, labelled Wi-Fi / Ethernet or Tailscale.

For the direct way to work:

- **Allow incoming connections.** If macOS asks whether Toolroll may accept incoming connections, click Allow. If you
  clicked Don't Allow, change it in System Settings → Network → Firewall → Options.
- **Allow Local Network on the iPhone.** The app asks the first time it looks for your Mac. If you declined, turn it on
  in Settings → Privacy & Security → Local Network → Toolroll.
- **Keep the Mac awake and Toolroll running.** Phones can't reach a Mac that's asleep. On a Mac that stays plugged in,
  turn on "Prevent automatic sleeping when the display is off" (System Settings → Energy, or Battery → Options on a
  laptop).

**From anywhere, through a relay (optional).** When you turn on phone access, you can also let the phone connect
through a relay when it isn't near the Mac. The default relay is `relay.toolroll.dev`, run by Toolroll. Everything
between the phone and the Mac is end-to-end encrypted (Noise, with keys that never leave the two devices). The relay
sees when your phone and Mac connect, from which addresses, and how much they send, never what they send. It can't
read your work or act for you. You can turn this off at any time in Settings → Phone. Start Toolroll with
`TOOLROLL_RELAY_URL=off` to remove the option entirely.

## Running your own relay

You can point Toolroll at a relay you run yourself by starting it with `TOOLROLL_RELAY_URL=wss://relay.example.com`.
The relay contract is in [`relay/PROTOCOL.md`](../relay/PROTOCOL.md). Two implementations live in this repository:

- `relay/reference/` — a small Node server with a Dockerfile, for any host that can run a container behind TLS;
- `relay/cloudflare/` — a Cloudflare Worker with Durable Objects.

A relay is a public endpoint, and its usage is billed to whoever runs it. If you deploy the Cloudflare relay, set a
usage alert on your Cloudflare account (Notifications → Billing / Usage-based billing) so an unexpected surge of
requests reaches you as an email before it reaches your bill.

## When it doesn't connect

| What you see | What to check |
| --- | --- |
| "Can't reach your Mac" | The Mac is awake, Toolroll is running, and phone access is on in Settings → Phone. On the same Wi-Fi, check the macOS firewall prompt and Local Network on the iPhone. |
| Settings → Phone says phones can't connect directly | Another app is using the phone port. Quit it, or start Toolroll with `TOOLROLL_PHONE_PORT` set to a free port. Connecting from anywhere still works if it's on. |
| "Another Toolroll with this workspace's keys is connected to the relay" | Two copies of the same workspace (for example a restored backup) are running with the relay on. Stop one, or turn off connecting from anywhere on one of them. |
| The app says your Mac removed this iPhone | The phone was removed in Settings → Phone, or your password changed. Pair it again. |
| "Toolroll on your Mac was reset or restored" | The workspace was restored or set up again. Pair the phone again. |
