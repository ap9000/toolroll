# Linux

## Install

The installer works the same as on macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/ap9000/toolroll/main/install.sh | sh
```

It needs Node.js 22.13 or newer (from nodejs.org, your package manager, or
`fnm install 22`) and git. If npm says permission denied, give it a folder
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
