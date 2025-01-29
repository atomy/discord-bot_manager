#!/usr/bin/env bash

set -e

#get highest tag number
VERSION=`git describe --abbrev=0 --tags`

#replace . with space so can split into an array
VERSION_BITS=(${VERSION//./ })

# get number parts and increase last one by 1
VNUM1=${VERSION_BITS[0]}
VNUM2=${VERSION_BITS[1]}
VNUM3=${VERSION_BITS[2]}
VNUM3=$((VNUM3+1))

# create new tag
NEW_TAG="$VNUM1.$VNUM2.$VNUM3"

if [ -z "$NEW_TAG" ]; then
  echo "[auto-tag] Unable to find old tag! Aborting!"
  exit 1
fi

echo "[auto-tag] Increasing \"$VERSION\" to \"$NEW_TAG\""

# get current hash and see if it already has a tag
GIT_COMMIT=`git rev-parse HEAD`
NEEDS_TAG=`git describe --contains $GIT_COMMIT 2>/dev/null || true`

# only tag if no tag already
if [ -z "$NEEDS_TAG" ]; then
    git tag $NEW_TAG
    echo "[auto-tag] Tagged with $NEW_TAG"
    git remote set-url origin git@github.com:atomy/discord-bot-central.git
    git push --tags
else
    echo "[auto-tag] Already a tag on this commit"
fi

echo $NEW_TAG > current_version

CHANGES=`git log --pretty=format:%B ${VERSION}..${NEW_VERSION} | sort | uniq`
echo ${CHANGES} | sed ':a;N;$!ba;s/\n/\\\n/g' > changes

sed -i "s|<discord-webhoook-url>|${DISCORD_WEBHOOK_URL}|" scripts/notification.sh
sed -i "s|<new-version>|${NEW_TAG}|" scripts/notification.sh
sed -i "s|<current-version>|${VERSION}|" scripts/notification.sh
