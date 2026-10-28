#!/bin/sh
# Install the git a CI lane tests against (.github/workflows/ci.yml, job "git"), run as root in a node:22-trixie
# container: 2.47 is Debian trixie's own; any other version is built from kernel.org's release tarball, checked against
# the hash pinned here, into /usr/local (ahead of /usr/bin on PATH). Fails unless `git --version` then names it.
set -eu
want="${1:?usage: ci-git.sh <major.minor>}"

case "$want" in
  2.47)
    # trixie's git; node:22-trixie already carries it, this just makes sure.
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends git >/dev/null
    ;;
  2.44)
    # Toolroll's declared floor (README: Requirements): `git --no-lazy-fetch` arrived in 2.44.
    release=2.44.4
    sha256=f36296411c58f21488abfacf365c5ba77c08ac39bc19d3aa1ef666e60d2da08f
    work="$(mktemp -d)"
    curl -fsSL --retry 3 -o "$work/git.tar.xz" "https://mirrors.edge.kernel.org/pub/software/scm/git/git-$release.tar.xz"
    echo "$sha256  $work/git.tar.xz" | sha256sum -c -
    tar -xJf "$work/git.tar.xz" -C "$work"
    # Only what the tests drive: no network transports, no Perl/Python/Tcl tools, no translations.
    make -C "$work/git-$release" -j"$(nproc)" prefix=/usr/local \
      NO_CURL=1 NO_EXPAT=1 NO_PERL=1 NO_PYTHON=1 NO_TCLTK=1 NO_GETTEXT=1 INSTALL_SYMLINKS=1 install >/dev/null
    rm -rf "$work"
    hash -r 2>/dev/null || true
    ;;
  *)
    echo "ci-git.sh: no recipe for git $want" >&2
    exit 2
    ;;
esac

found="$(git --version)"
echo "$found ($(command -v git))"
case "$found" in
  "git version $want."*) ;;
  *) echo "ci-git.sh: wanted git $want, got: $found" >&2; exit 1 ;;
esac
