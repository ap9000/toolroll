# Linux

## Install

The installer works the same as on macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/ap9000/toolroll/main/install.sh | sh
```

It needs Node.js 22.20 or newer and git. Your distribution's own `nodejs`
package is usually too old (Ubuntu 24.04's is 18): install Node from
https://nodejs.org/en/download (choose nvm, then `nvm install 22`) or from
[NodeSource](https://github.com/nodesource/distributions). If npm says permission denied, give it a folder
you own: https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally

## Install the sandbox tools

```sh
sudo apt install bubblewrap socat ripgrep      # Debian, Ubuntu
sudo dnf install bubblewrap socat ripgrep      # Fedora
```

Toolroll runs Claude and Gemini agents in a sandbox where its own secrets
don't exist, and the sandbox needs all three. Until they're installed,
`toolroll` says which are missing and doesn't start. See
[Security](security.md).

## Start over without a password

If Toolroll was started before the sandbox tools were installed, it may
have set itself up with a password. When it says "This Toolroll was set up
with a password", you can start over without one:

1. Stop Toolroll everywhere: run `toolroll stop`, run
   `toolroll background off` if you turned that on, and quit every terminal
   window running `toolroll`. Check that nothing still listens:
   `ss -ltnp | grep node` (on a Mac, `lsof -nP -iTCP -sTCP:LISTEN | grep node`)
   shows no Toolroll.
2. Know what you discard: moving the folder aside leaves behind everything
   that installation holds: its tasks, results, settings and saved
   password. Your projects' own folders aren't touched. Nothing is deleted:
   move the folder back to undo.
3. Move Toolroll's folder aside, then start again:

   ```sh
   mv ~/.config/toolroll ~/.config/toolroll.old
   toolroll
   ```

   The folder is `~/.config/toolroll` on Linux and macOS
   (`$XDG_CONFIG_HOME/toolroll` when `XDG_CONFIG_HOME` is set). Older
   installs may use `standing-orders` or `nightorders` instead of
   `toolroll`; if you set `TOOLROLL_DB`, it's the folder holding that file.

## Process containment

On a first start you may see:

> Agents run without Linux process containment on this machine (it needs a
> delegated cgroup). That's fine for trying Toolroll; see docs/guide/linux.md
> to turn it on.

Without containment, Toolroll still tracks and stops every agent, setup
and check process it starts. With it, each one runs in its own cgroup, so
nothing it leaves behind outlives a stop.

To turn it on, you need cgroup v2, Linux 5.14 or newer, and a cgroup this
user may manage. The simplest way is the user service below with
`Delegate=yes` under `[Service]`, and `--containment preferred` added to
`ExecStart` (or `TOOLROLL_CONTAINMENT=preferred`). Inside Docker, the
container's cgroup is usually read-only, so containment stays off there.

`toolroll up --verbose` prints the exact reason; a service log always
has it. [Process containment](../PROCESS_CONTAINMENT.md) has the details.

## Keep it running

`toolroll up` runs until you stop it. To keep it running after you log
out, run it as a user service. Save this as
`~/.config/systemd/user/toolroll.service`:

```ini
[Unit]
Description=Toolroll

[Service]
ExecStart=/usr/bin/env toolroll up --project-root %h/Projects --no-open
Restart=on-failure

[Install]
WantedBy=default.target
```

Then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now toolroll
loginctl enable-linger "$USER"     # keep it running when you're logged out
journalctl --user -u toolroll -f   # what it's doing
```

If `toolroll` isn't on the service's PATH, use the full path from
`command -v toolroll` in `ExecStart`.

## Reaching it from elsewhere

On a server, put it on your tailnet: `toolroll up --host 0.0.0.0
--allow-host <machine>.ts.net:4180`, and open `http://<machine>.ts.net:4180`
from your laptop or phone.
