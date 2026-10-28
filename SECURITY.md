# Security Policy

Open HR runs a daemon as root and manages storage, so security reports are
taken seriously.

## Supported versions

Until 1.0 only the latest release receives fixes.

## Reporting a vulnerability

Do not open a public issue. Report it privately through
[GitHub security advisories](https://github.com/nvitaterna/open-hr/security/advisories/new).

Include what you found, how to reproduce it, and the impact you expect. You
will get a first response within seven days. Fixes are released as soon as
practical, and reporters are credited unless they ask not to be.

## Scope

In scope: the root daemon and its socket API, the web server and UI,
authentication, the CLI, packaging and install scripts, and anything that
could lead to privilege escalation or data loss.

Out of scope: bugs in `mdadm`, LVM, the kernel, or other upstream tools.
Report those upstream, though we are happy to hear about them too.
