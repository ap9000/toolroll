# Troubleshooting

**"Sorting needs an OpenRouter key."** Add one in Settings → AI providers →
OpenRouter. **Check again** there tests it.

**"Claude isn't signed in on this computer."** A Draft zone uses Claude
Code's own sign-in: run `claude` in a terminal and sign in.

**"Email isn't set up yet."** Settings → Email, then **Send a test email**.

**"There's no tool called … in this project."** Add it on Settings → Tools,
set its secrets, and **Test** it.

**"Set the secret … on the step first."** Open the Web request zone in
**Edit flow** → Secrets, and save it there.

**"There's no one to send it to: the card has no email address."** The card
doesn't mention an email address; ask for one in the form that makes it.

**A card waits with "Trying again in 5 minutes".** Something it calls
didn't answer. It tries twice more (5 and 15 minutes), then takes the
failure path. **Insights** has the run's log.

**The builder is disconnected.** Start `toolroll up` again on the
computer where your projects are; queued work resumes.

**"Too many wrong passwords. Try again in 15 minutes."** Five wrong
passwords in a row lock a name. Wait, or restart Toolroll to clear
it. **Audit log** (filter Sign-ins) shows the attempts.

**Forgot your password.** On the computer running Toolroll, your first
password is saved in `~/.config/toolroll/.toolroll-secrets/up-login.txt`
until you change it (the sign-in page, opened on that computer, shows the
exact path). Changed it and forgot? Run `toolroll password reset` in a
terminal on that computer: type the new one twice. Its browser sessions,
remembered passwords, paired chats, phone notifications, lead sessions and
lead tokens end; API and MCP tokens and coordinator credentials stay (revoke
them in Settings → Sessions & tokens and with `toolroll coordinator revoke`).
The saved file is removed once it no longer works. With more than one
person, add `--as <name>`.
Anyone who can run commands as you on that computer can do this, just as
they could read the saved file. Accounts that sign in with an identity
provider reset their password there instead.

**The sign-in page asks for a password on a password-free install.**
Signing in without a password works only on the computer running Toolroll:
there, run `toolroll open --web`. From a phone or another computer, set a
password first (`toolroll password set` on that computer).

**"database is locked" from the command line.** The app was writing at that
moment: run the command again.
