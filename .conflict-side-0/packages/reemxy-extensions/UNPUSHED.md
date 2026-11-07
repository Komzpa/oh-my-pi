# Unpushed work

Lead sessions measure commits reachable from checkout HEAD but absent from every
live remote head. The check uses `git ls-remote --heads`, never tracking refs or a
fetch. It runs asynchronously at startup, on TODO transitions, and on the plan
ticker; ordinary checks share a three-minute cache and an in-flight probe.
Remote tips are checked together in one `cat-file --batch-check` process. Tips
whose objects are unavailable locally cannot establish ancestry without fetching;
they are ignored conservatively. Remote failures leave publication unconfirmed.

After 60 minutes, dispatch sends one notice and places a push row first in the
plan. The row calls for the project's required gates, then publication and remote
readback. It reopens if closed before publication and closes once no commits
remain unpublished. A new unpublished episode can notify again. The status line
shows `N unpushed · oldest Xm` even before the threshold.

Project overrides use local Git configuration:

```sh
git config --local omp.unpushedThresholdMinutes 30
git config --local remote.pushDefault fork
# For detached lead checkouts, name the existing PR branch explicitly:
git config --local omp.pushBranch topic/my-existing-pr
```

The branch defaults to the current branch. The remote follows branch pushRemote,
remote.pushDefault, branch remote, then origin. This schedules work; it never
runs gates or pushes on its own and does not grant publication authority.
