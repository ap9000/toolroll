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

**"database is locked" from the command line.** The app was writing at that
moment: run the command again.
