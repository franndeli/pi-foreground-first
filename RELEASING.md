# Releasing

1. Update version/changelog and run `npm test`.
2. In a disposable Orca workspace, run `ORCA_SMOKE=1 npm run test:smoke`.
   Optionally add `ORCA_SMOKE_AGENT=pi` for a real model reply check; this uses quota.
   Install the checkout into Pi and run `ORCA_MANAGED_SMOKE=1 npm run test:managed`
   to verify automatic wake-up after success, failure, cancellation and reload.
   This uses four real model responses and cleans up only its own terminals.
3. Run `npm pack --dry-run` and inspect the exact file list. No credentials, machine paths, settings, node_modules, or transcripts belong in the package.
4. Commit and push; check GitHub CI. Tag a release only after its checks pass.
5. Authenticate locally using `npm login` and verify `npm whoami`.
   Never put an npm token into this repository or a chat transcript.
6. Publish with `npm publish --access public`. Complete the interactive browser/2FA challenge if npm requires it.
7. Verify `npm view pi-foreground-first version dist.integrity`.
8. Update README wording to reflect registry availability after the first successful publication.

The initial GitHub distribution is usable with
`pi install git:github.com/franndeli/pi-foreground-first` even before npm publication.
A successful GitHub push or `npm pack` is not proof of npm publication.

## Local rollback

```sh
pi remove /absolute/path/to/pi-foreground-first
```

For git/npm installs, remove that exact configured source instead. Restart Pi.
Removing this extension does not close Orca-owned jobs; inspect/close them explicitly.
