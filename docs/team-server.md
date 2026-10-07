# A team server on a real domain

One always-on Linux host runs Toolroll for the team: the database, the console, the agents and their runner.
Engineers reach it at `https://toolroll.example.com` with their own API tokens. Replace that name throughout.

Toolroll listens on `127.0.0.1:4180` only. A TLS proxy on the same host (Caddy or Cloudflare Tunnel) serves the
domain and forwards to it. Toolroll trusts `X-Forwarded-For` and `X-Forwarded-Proto` only from a loopback peer, so
the proxy must run on the same host. API tokens over plain HTTP are refused unless they come from the host itself
or your tailnet. Over HTTPS through the proxy, Toolroll sends `Strict-Transport-Security: max-age=31536000`.

## 1. Install on the host

Use an ordinary account (here `toolroll`) with Node.js 22.13+, git and npm.

```sh
sudo useradd --create-home --shell /bin/bash toolroll
sudo loginctl enable-linger toolroll          # its services run without a login
sudo -iu toolroll
curl -fsSL https://raw.githubusercontent.com/ap9000/toolroll/main/install.sh | sh
mkdir -p ~/Projects ~/.config/toolroll ~/.config/systemd/user
claude    # sign in the agent CLIs the runner will use (claude, codex), once
```

## 2. Run it as a service

`~/.config/systemd/user/toolroll.service` (set `ExecStart` to the path `command -v toolroll` prints):

```ini
[Unit]
Description=Toolroll team server
After=network-online.target

[Service]
ExecStart=/home/toolroll/.npm-global/bin/toolroll up --no-open --runner server --project-root /home/toolroll/Projects --public-url https://toolroll.example.com
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now toolroll
journalctl --user -u toolroll -f      # the first start says where your password is saved
```

`--runner server` is the runner on this host; agent work runs here, so engineers never need a checkout of their own.

## 3. Put HTTPS in front

**Caddy** (gets and renews the certificate; sends the forwarded headers and keeps the Host). `/etc/caddy/Caddyfile`:

```caddy
toolroll.example.com {
	reverse_proxy 127.0.0.1:4180
}
```

```sh
sudo systemctl reload caddy
```

**Cloudflare Tunnel** (no open inbound ports). As `toolroll`:

```sh
cloudflared tunnel login
cloudflared tunnel create toolroll
cloudflared tunnel route dns toolroll toolroll.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: toolroll
credentials-file: /home/toolroll/.cloudflared/<TUNNEL-ID>.json
ingress:
  - hostname: toolroll.example.com
    service: http://127.0.0.1:4180
  - service: http_status:404
```

```sh
sudo cloudflared service install
```

## 4. Check it

```sh
toolroll serve check-public --public-url https://toolroll.example.com --port 4180
```

It sends no credentials and changes nothing. It checks the URL, any `--allow-host` you pass, that the local server
answers as the domain and refuses tokens relayed over plain HTTP, the certificate, HSTS, and that the proxy is on
this host. Each problem prints as one line with the fix. It exits 0 when ready.

## 5. Backups

Turn on scheduled backups in **Settings → Backups** (how often, how many to keep, which folder). Then:

```sh
toolroll backup now
toolroll backup list
rsync -a ~/.config/toolroll/backups/ backup-host:toolroll/   # keep a copy off the host; use the folder you chose
```

To restore, stop the service, run `toolroll restore <backup file> --dry-run`, then without `--dry-run`, then start it.

## 6. Add repositories from GitHub

Give the host read access to GitHub (`gh auth login`, or a deploy key), then:

```sh
toolroll repos add-from-github your-org/your-repo --root ~/Projects          # preview
toolroll repos add-from-github your-org/your-repo --root ~/Projects --yes    # clone and add
```

Give people access to projects in **People** in the console.

## 7. Engineers connect

Each engineer makes their own API token in the console (**Settings → Sessions & tokens**) and saves it in a private file.
Never paste it into a command line.

```sh
umask 077 && pbpaste > ~/.config/toolroll-token        # or save it with your editor
toolroll connect https://toolroll.example.com --as YOUR_ACCOUNT --token-file ~/.config/toolroll-token
toolroll status --repo /home/toolroll/Projects/your-repo
```

`--token-stdin` works too: `toolroll connect https://toolroll.example.com --as YOUR_ACCOUNT --token-stdin < ~/.config/toolroll-token`.

For your coding agent, read the token from the environment so it never appears in a command or a committed file.
In your shell profile:

```sh
export TOOLROLL_TOKEN="$(cat ~/.config/toolroll-token)"
```

Then in your project (the single quotes keep `${TOOLROLL_TOKEN}` unexpanded; Claude Code fills it in when it connects):

```sh
claude mcp add --transport http --scope project toolroll https://toolroll.example.com/mcp --header 'Authorization: Bearer ${TOOLROLL_TOKEN}'
```
