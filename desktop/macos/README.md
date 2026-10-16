# macOS onboarding preview

Needlefish has a native SwiftUI app for one trusted local Git project. The app calls the existing `doctor`, dry-run and review commands. It does not run a second review engine or HTTP server.

This is a development preview for macOS 14 or newer on Apple silicon. It is not a qualified download for nontechnical users. Issue #150 remains open. No other platform is claimed as supported. [Process ownership](PROCESS.md) records the lifecycle census and limits.

## Run the development preview

Use the installed Swift 6 toolchain and existing binaries. This does not install Node, Git or Codex. Build the CLI with the repository's existing `pnpm build` command first.

```sh
python3 desktop/macos/scripts/package.py --development \
  --node /absolute/path/to/node \
  --cli /absolute/path/to/needlefish/dist/cli.js \
  --codex /absolute/path/to/codex \
  --git /absolute/path/to/git
open desktop/macos/build/Needlefish.app
```

The script refuses to overwrite an app. Choose another `--output` path for the next build. Development paths exist only in the generated app and are not committed.

The app uses one recommended candidate, official OpenAI Codex 0.163.0 with `gpt-5.6-sol` at medium effort. This exact desktop lane still requires release qualification. It does not inherit provider overrides, API keys, proxy credentials or connection profiles from the shell. Existing Codex login storage remains under the provider's control. Diagnostics do not prove model access, quota or network availability.

## Use the app

1. Open Needlefish. Choose your own trusted project folder.
2. Read the environment checks and the actual Git project root. Selecting a subfolder resolves to that root and reviews its local changes. Checks make no model call. A folder without Git is explained without initializing or modifying it.
3. Use **Sign in** before starting a review if needed. You can inspect **Review scope** while signed out. The app runs official `codex login --device-auth`. Open the displayed OpenAI link and enter the one-time code. Cancel stops that login attempt. Never enter your account password into Needlefish.
4. Open **Review scope**. The first version reviews staged, unstaged and eligible new local files. It does not review a clean branch's committed changes. No changes means no review occurred.
5. Read the code destination and cost notice. Confirm project ownership and consent before **Start review** becomes available. The app captures the copy at start, so stop editing during capture. The preview is not a locked snapshot of what you saw earlier.
6. Read the verdict, findings and next step. A pass covers the captured change only. **Human review needed** is not a pass. A failed or cancelled attempt never displays a fake result.

The native UI presents Traditional Chinese and English together. It reports real phases, without invented percentages. The JSON CLI intentionally suppresses detailed progress events, so the UI currently shows environment, scope and review phases only.

**Offline example** never reads the project, calls a model or writes review cache. It stays labelled as an example. The separate fake CLI below is for developer UI checks and also does not call a model.

**Preview diagnostics** shows the entire export before saving. It omits code, prompts, raw CLI output, private paths and account data. Nothing is uploaded. Actual reviews use the existing CLI cache; installation removal preserves that shared cache and provider login.

## Verify without an account

```sh
swift test --package-path desktop/macos -j 2
python3 desktop/macos/scripts/test-package.py
python3 desktop/macos/scripts/smoke-fixture.py /tmp/needlefish-ui-fixture
python3 desktop/macos/scripts/package.py --development \
  --node /bin/sh --cli /tmp/needlefish-ui-fixture/fake-cli \
  --codex /tmp/needlefish-ui-fixture/fake-cli --git /usr/bin/git \
  --output /tmp/Needlefish-UI-Test.app
```

Launch the generated app in its own process group. Select a temporary folder, inspect diagnosis, start and cancel login, inspect consent, then run the fake review. The result says `OFFLINE UI TEST`. Also open the built-in offline example and diagnostic preview. Quit the app and terminate its owned process group after the check. Fake CLI success is not proof of real authentication or model behavior.

## Build a distribution package

`runtime-lock.json` is deliberately unapproved. Production packaging fails before running artifacts until maintainers supply the following reviewed release inputs.

- Exact approved Node, Git, Codex and built Needlefish files, including required libraries and Git helper programs.
- SHA-256 for every file and an exact file inventory. Unexpected, missing, modified and symlink files fail validation. Sources must be verified against upstream signed release checksums before the lock is approved.
- Redistributable license notices, including Git GPL obligations and corresponding-source distribution. The existing development host is not evidence of redistribution permission.
- An exact recommended runner and model qualification result. Runtime capability and terminal-failure contracts from #146 and #145 must be integrated through the existing CLI, not copied into Swift.
- A Developer ID application identity and its team identifier.

The entire approved runtime is copied inside the app. End users need no package manager, PATH change, shell command or additional download. Release packaging requires an Apple silicon macOS build host, explicitly builds arm64, and checks every native app/runtime file with `lipo -verify_arch arm64` before signing. Each build atomically reserves its own output directory before building and only removes that owned directory on failure. Runtime bytes are copied into that private directory and verified there before signing, so a changing input directory cannot bypass the lock. The builder signs nested native binaries and the app, then verifies the signed bundle against the configured team and Developer ID Application certificate. Node alone receives `com.apple.security.cs.allow-jit`; the builder reads back and checks that entitlement. The exact Node release must still pass signed runtime qualification. It does not grant debugger, unsigned executable-memory or library-validation bypass entitlements.

```sh
python3 desktop/macos/scripts/package.py \
  --runtime /absolute/path/to/approved-runtime \
  --signing-identity 'Developer ID Application: Example (TEAMID)' \
  --team TEAMID --output /absolute/new/path/Needlefish.app
```

Signing is not notarization. Before a release is downloadable, notarize and staple through Apple's official tooling, verify Gatekeeper acceptance and test on a clean Apple silicon machine without developer tools or existing Node, Git or Codex. Never instruct users to disable Gatekeeper.

The app's **Install release** copies a user-selected official app into `~/Library/Application Support/Needlefish/Desktop`. It validates the expected bundle identifier and Developer ID team before switching its receipt. Failed verification or launch keeps the prior receipt and attempts to remove only that candidate copy. This cleanup is best effort. If removal fails, inspect the Desktop folder above and move the failed candidate to Trash; **Remove installations** does not remove unrecorded candidates. Quitting while macOS launch confirmation is pending does not wait for that callback or cancel the macOS launch. The existing receipt stays unchanged, and an unrecorded candidate copy may remain in the Desktop folder. The prior version is retained. Restore commits its receipt only after macOS reports a successful launch. **Restore previous** verifies and opens that version without changing account or provider. macOS still applies its normal application launch policy. There is no automatic updater or network installer.

**Remove installations** deletes only app versions listed in the desktop receipt and that receipt. Upgrades retain older versions in the receipt until cleanup succeeds. A later installation or removal retries that cleanup. If removal fails, the receipt remains for retry. Unknown files, repositories, user Git installations, provider credentials and shared CLI cache stay intact. Downloaded or manually copied apps can be moved to Trash. The offline example has no data to remove.

## Release gates still open

- Approved upstream digests and redistribution review for the complete self-contained runtime.
- Developer ID signing, notarization and actual Gatekeeper tests.
- Clean-machine install, failed upgrade, rollback and uninstall with the signed real runtime.
- Controlled real login, cancellation, network and quota tests, plus an exact-lane real review canary.
- Integration with the finalized #145 failure, #146 capability and #149 runtime contracts.
- Five novice trials, at least four independent successes, including correct result interpretation.

The fake CLI and development machine do not satisfy these gates. Do not close #150 or publish this preview as a supported installation until they pass.
