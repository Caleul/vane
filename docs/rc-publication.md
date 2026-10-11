# RC publication workflow

`.github/workflows/release.yml` is dispatch-only and publishes RC versions to npm's `next` tag. GA versions are explicitly rejected by the publication policy. Implementing this workflow does not dispatch it or publish anything.

The dispatch must run from `main`. Publication validates the current main HEAD and requires successful completed **push** runs of the trusted `ci.yml`, `phase-8.yml`, and `release-readiness.yml` workflows at that exact SHA. PR and manually dispatched readiness runs do not authorize publication. The latest matching run must be green. The canonical artifact is selected by readiness run ID and fixed name `release-candidate-{sha}`; users cannot supply another head, workflow run, artifact name, package version or npm tag.

The artifact root must contain the pack manifest `package.json` and its canonical `.tgz`. The script checks the manifest schema, source commit, RC version, actual SHA-256/SHA-512 and internal npm package metadata. Archive paths must be safe regular files. The publication command submits those exact tarball bytes with `--tag next --access public --provenance`, using the public npm registry.

Configure either the repository secret `NPM_TOKEN` with an npm granular token or npm trusted publishing bound to this GitHub repository and `release.yml` workflow. No GitHub environment or approval gate is required by this workflow. A token path executes `npm whoami` first; trusted publishing requires GitHub OIDC and npm >=11.9. Credential values and failed subprocess output are withheld. The local inability to read GitHub secrets is not proof that the workflow secret is absent. Local `npm whoami` without authentication cannot publish; no publication has been attempted here.

After npm publication, the script waits for matching registry integrity, performs a fresh registry installation with lifecycle scripts disabled, checks installed lock integrity and compares every packaged file's bytes to the canonical artifact. Only then does it write a VERIFIED publication receipt and expose the version to the tag/release step. The workflow creates the Git tag explicitly at the verified SHA (existing tags cause failure), then creates a prerelease requiring that tag. The receipt is attached and uploaded as workflow evidence. Registry verification failure stops tag/release creation; npm publication itself may already have occurred. Publication is intentionally not automatically retried: npm versions are immutable, and rerunning the dispatch for an existing version fails. Preserve the failed run and its exact canonical artifact, check the published version’s registry integrity against its manifest, then repeat the fresh installation and all packaged-file comparisons in a separately reviewed recovery run. Only after those checks pass should that recovery run issue a VERIFIED receipt tied to the original publication run, artifact SHA and source commit, and create the missing tag/prerelease. Never use a new tarball under the same version or treat an existing npm version as verification success. There is no automatic recovery bypass in this workflow.

Publication requires all remote checks and configured npm authentication; neither was assumed from local test success. Four local policy tests validate trusted run selection, tampered hashes/versions/heads, GA refusal, registry-origin/integrity failure and unauthorized local execution. They exercise no remote mutation.

```sh
node --test scripts/release/publish.test.mjs
```

GA publication remains blocked. It needs a separate reviewed promotion implementation tied to a genuine verified RC registry receipt and post-RC acceptance evidence; changing a dispatch input cannot bypass this RC-only gate.
