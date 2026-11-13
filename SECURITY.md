# Security

vs-kot is a fork of Code - OSS that one team builds for its own daily work.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through [Report a vulnerability](../../security/advisories/new) on the Security tab of this repository.

A problem that also exists in Visual Studio Code itself is upstream's to fix. Report it to Microsoft as their [security policy](https://github.com/microsoft/vscode/security/policy) describes.

## What to know about releases

Releases are not signed with an Apple developer certificate. They are signed with a key of our own that is not kept on GitHub. The app updates itself from the releases of this repository and installs only what carries this signature and has the SHA-256 that the release announces. Version 0.5.0 does not check the signature yet.
