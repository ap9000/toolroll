# Steps that reach outside

These zones send a card's details to something outside Toolroll. Put
a **Person decides** zone before any of them that sends what a model wrote
or what an outsider typed.

## Sort (Jev)

Jev, TypeSafe's decision model, reads the card and picks one of the zone's
answers, with how sure it is. Cards it is sure enough about (80% by default)
go where their answer leads; the rest take the not-sure path. It can also
note up to three scores or yes/no answers ("How urgent is it?").

Needs an OpenRouter key: Settings → AI providers → OpenRouter. A sort costs
a fraction of a cent. Jev reads only what's on the card: not code, images, or
anything it would have to look up.

## Draft (Claude)

Claude writes what the zone asks, from the card and what earlier zones said,
in a few seconds. It uses the lead chat's Claude sign-in, with no repository
and no tools, and sends nothing itself. Follow it with a Person decides zone:
the draft appears there as an editable box (and on Telegram with Approve,
Edit and Send back). Sent back, Claude redrafts with the person's note.

## Web request

Calls an address with a method, headers and a body. The address's host is
written out in the zone; fill-ins can go after it and are encoded, so a card
can't change where the request goes. JSON bodies stay JSON, with fill-ins
inside their strings.

Secrets (an API token, say) are saved on the step under **Secrets** and used
in headers as `{{secret.NAME}}`. They're kept in a private file on this
computer, never shown again, and blanked if an answer echoes them back.

A 4xx answer takes the failure path; a 5xx or no answer is tried again
(after 5, then 15 minutes). The answer is kept for later zones as
`{{stage.<zone id>}}`.

## Send email

Sends from your own email account, set up in Settings → Email. Either:

- **A mail server.** For Gmail: smtp.gmail.com, port 587, your address and
  an app password. Outlook, Fastmail, Resend, SES and any SMTP server work
  the same way. To let Email inbox triggers read it too, add its IMAP
  address (for Gmail, imap.gmail.com, port 993).
- **A Google account**, signed in with Google instead of an app password.
  Make an OAuth client of type *Web application* in Google Cloud Console,
  set its consent screen to *In production* (in Testing, Google ends the
  connection after 7 days), add the redirect address Settings shows, and
  paste the client ID and secret. Google warns that it hasn't verified the
  app; it's your own, so continue.

**Send a test email** and **Check the inbox** try it. Passwords, the client
secret and Google's sign-in stay in private files on this computer.

`{{card.email}}` is the first email address the card mentions, so a form
that asks for an email address can be answered by email. When a card came
from an email and the step writes back to its sender, the reply goes in the
same thread. A card with no address, or an address the server refuses,
takes the failure path.

## Use a tool

Calls one function of one of the project's tools: the MCP servers on
Settings → Tools, like Slack, Notion, Linear or your own. Choose the tool,
what it does, and its arguments as JSON with fill-ins. **Test** on the Tools
page lists what a tool can do. A tool that says it failed takes the failure
path.

### Connect a service with one click

Settings → Tools → **Connect with one click** lists services whose tools you
connect by signing in: Stripe, Notion, Linear, Sentry, Jira and Confluence,
Intercom, Attio, Zapier, Square, PayPal, Klaviyo, Webflow, Wix, Canva, Vercel
and Cloudflare. Enter your Toolroll password, pick the service, and
allow Toolroll on the service's own page. You never copy a key.

The sign-in is kept in the tool's secrets file on this computer, never in the
database, and Toolroll renews it before it runs out. If a service
stops accepting it (you removed the app on the service's side, say), the log
says so and the tool's test fails; click the service again to sign in again.
Connecting from a starter kit's checklist also lets the kit's subagent use
the tool: reading freely, the rest after you approve each call.

## Update where it came from

For cards that came from GitHub or Linear: comments on the issue, and can
close it (Linear: moves it to done), with your own `gh` login and Linear key.
For cards that came from a Slack, Discord or Teams channel: answers in the
message's thread, through the chat of whoever connected the channel.
