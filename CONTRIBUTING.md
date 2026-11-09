# Contributing

## Setup

The repository uses [Bun](https://bun.sh); the version is pinned in `package.json`.

```bash
bun install
bunx vp check       # format and lint
bunx vp test        # unit tests
bun run typecheck
bun run build
```

`bunx vp fmt` formats the code. The scene viewer runs with `cd apps/viewer && bun run dev` on
http://localhost:5199/?demo=bolt_sweep.

The browser tests need a GPU with WebGPU subgroups, so they do not run in CI. Start the viewer, then run
`bun run e2e` in `apps/viewer`.

## Pull requests

- Branch from `main` and open a pull request into `main`. Pull requests are squash-merged.
- Use a [Conventional Commits](https://www.conventionalcommits.org) title, such as `fix: ...` or `feat: ...`.
- CI runs format, lint, unit tests, typecheck and build, and must pass before merging.

## Changesets

A change to the published package, `@skild-ai/steel-webgpu`, needs a changeset. It records the version bump and the
changelog line for the next release.

```bash
bun changeset
```

Pick the bump and write one line for the changelog, then commit the file it creates under `.changeset/`. While the
package is at 0.x, use `minor` for breaking changes and `patch` for everything else. Changes that only touch the
apps, examples, tools, scenes or docs need no changeset.

## Releasing

Maintainers release by opening a release pull request.

1. Create a release branch from the latest `main` and apply the pending changesets:

   ```bash
   git switch -c release/<version> origin/main
   bun changeset version
   ```

   This bumps the version in `packages/steel-webgpu/package.json`, adds the changelog entry and deletes the applied
   changesets.

2. Review the changelog, commit with the message `chore: release @skild-ai/steel-webgpu <version>`, push, and open a
   pull request.

3. Merge it once CI passes. If more changesets land on `main` first, update the branch and run
   `bun changeset version` again. A release only publishes when no changesets are pending.

4. The Release workflow builds and packs the package, then waits for approval on the `npm` environment. Approve it
   under Actions, Release, Review deployments.

5. The workflow publishes to npm with provenance, tags the commit `@skild-ai/steel-webgpu@<version>` and creates the
   GitHub release.
