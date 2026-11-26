#!/bin/sh
# One container lane of the install smoke (.github/workflows/install-smoke.yml): set the lane's machine up the way its
# people have it, then run scripts/container-smoke.mjs as the lane's user. Runs as root inside a throwaway container,
# with the packed tarball and the smoke at /work.
#
#   sh /work/container-smoke.sh <lane>
#
# Lanes (what a person there gets from `toolroll`, first and again):
#   ubuntu-umask002   Ubuntu 24.04 desktop default: a user with umask 0002 and npm's prefix in their home, sandbox
#                     working. The first start refuses with the exact repair (group-writable install); after running
#                     it, a clean password-free start.
#   no-userns         Docker's default profile: no user namespaces. Refused, with why and an explicit password road;
#                     nothing made, so the second start says the same.
#   alpine            Alpine (musl), busybox ps (no procps), sandbox working: opens, both times.
#   fedora            Fedora, no procps-ng, sandbox working: opens, both times.
#   debian12          Debian 12's git 2.39: refused at the git floor, nothing made.
#   debian13          Debian 13 (git 2.47), sandbox working: opens, both times.
set -eu
lane="$1"
tarball=$(ls /work/toolroll-*.tgz)
packages_apt="git ca-certificates bubblewrap socat ripgrep bsdutils"
apt_install() { export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq --no-install-recommends "$@" >/dev/null; }

case "$lane" in
  ubuntu-umask002|no-userns|debian12|debian13) apt_install $packages_apt ;;
  alpine) apk add --no-cache nodejs npm git bubblewrap socat ripgrep bash util-linux-misc >/dev/null ;;
  fedora) dnf install -y -q nodejs npm git bubblewrap socat ripgrep util-linux which >/dev/null ;;
  *) echo "unknown lane: $lane" >&2; exit 2 ;;
esac
# Node: the image's own, else the runner's, mounted read-only at /opt/node.
command -v node >/dev/null 2>&1 || PATH="/opt/node/bin:$PATH"
node --version

smoke() { node --disable-warning=ExperimentalWarning /work/container-smoke.mjs --tarball "$tarball" "$@"; }
case "$lane" in
  ubuntu-umask002)
    useradd -m -s /bin/sh dev
    chmod 0644 "$tarball"
    # As the user, with a desktop umask (0002) and the npm prefix in their home (as npm advises for EACCES).
    exec su dev -c "PATH=$PATH node --disable-warning=ExperimentalWarning /work/container-smoke.mjs --tarball $tarball --umask 0002 --home-prefix --first refuse --words 'can.t be trusted' --words 'Fix it with:' --words 'chmod -R go-w' --repair --again open" ;;
  no-userns) smoke --first refuse --words 'Agents can.t run in a sandbox here' --words 'toolroll up' --again refuse ;;
  debian12) smoke --first refuse --words 'needs git 2\.41' --again refuse ;;
  alpine|fedora|debian13) smoke --first open --again open ;;
esac
