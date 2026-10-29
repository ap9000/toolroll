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
  2.41)
    # Toolroll's declared floor (README): the global `git --attr-source` option arrived in 2.41. Older than 2.45 has no `--no-lazy-fetch`,
    # so Toolroll refuses partial clones for protected reads there (teardown-git.ts lazyFetchSupported).
    release=2.41.3
    sha256=baa39125deee194b440ac7d0138f6c34f0d87ceb1cb9da5b2becf704f45b0819
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
