if ! STATUS=$(git status --porcelain); then
  echo "Unable to check git state." >&2
  exit 1
fi
if [ -n "$STATUS" ]; then
  echo "The git repo is not clean after compiling the /build/ folder. Did you forget to commit .js output for .ts files?";
  git status --porcelain
  echo "\nUnstaged diff:";
  git --no-pager diff
  echo "\nStaged diff:";
  git --no-pager diff --cached
  exit 1;
fi
