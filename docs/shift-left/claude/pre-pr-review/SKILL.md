---
name: pre-pr-review
description: Review the committed branch before opening or updating a pull request.
disable-model-invocation: true
---

Read `.needlefish/shift-left/README.md` and follow its canonical review procedure.
Run the gate once against the PR's intended base ref. Completion requires the
procedure's pass result. Report the confirmed findings or the failed check to
the user. Apply a repair only within the user's authorized coding task, then
verify the changed behavior. A new review requires a deliberate new invocation.
