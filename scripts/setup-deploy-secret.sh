#!/usr/bin/env bash
# One-time: lets the "Copy sync + deploy" GitHub Action deploy to Firebase Hosting.
# Creates a Hosting-only service account, stores its key as a GitHub repo secret (the key never touches disk
# outside a 0600 temp file that is deleted on exit, and is never printed), then triggers a run.
# Requires: gcloud (logged in as a project owner) and gh (logged in as kendellproduction).
set -euo pipefail
P=fuse-prints; SA=github-hosting-deploy; EMAIL="$SA@$P.iam.gserviceaccount.com"; REPO=kendellproduction/Fuse-Prints

gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . || { echo "Run: gcloud auth login"; exit 1; }
gcloud iam service-accounts describe "$EMAIL" --project "$P" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$SA" --display-name "GitHub Hosting deploy" --project "$P"
for role in roles/firebasehosting.admin roles/serviceusage.apiKeysViewer; do
  gcloud projects add-iam-policy-binding "$P" --member "serviceAccount:$EMAIL" --role "$role" --condition=None >/dev/null
done

umask 077; KEY=$(mktemp); trap 'rm -f "$KEY"' EXIT
gcloud iam service-accounts keys create "$KEY" --iam-account "$EMAIL" --project "$P" >/dev/null
gh secret set FIREBASE_SERVICE_ACCOUNT_FUSE_PRINTS --repo "$REPO" < "$KEY"
rm -f "$KEY"
echo "Secret set. Triggering a deploy run..."
gh workflow run "Copy sync + deploy" --repo "$REPO"
echo "Done. Watch it: gh run watch --repo $REPO"
