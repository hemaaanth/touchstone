#!/bin/sh
# Runs once after boot. Re-pulls the pinned proof image if a cleanup removed it,
# restores the keepalive container, and checks the loopback path through Traefik.
# Fails loudly in the journal instead of leaving the demo silently dead.
set -u
IMG='ghcr.io/foundry-rs/foundry:latest@sha256:3a392c18f9b16e665e932de159fb6fa9ed972c4b4352f2f76a1a8c7ca9b57d39'

docker image inspect "$IMG" >/dev/null 2>&1 || docker pull -q "$IMG" || exit 1
docker container inspect touchstone-foundry-keepalive >/dev/null 2>&1 ||
  docker create --name touchstone-foundry-keepalive --entrypoint true "$IMG" || exit 1

systemctl is-active --quiet touchstone-demo.service || exit 1
systemctl is-active --quiet touchstone-demo-proxy.socket || exit 1

code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: touchstone.hem.so' \
  -H 'X-Real-IP: 127.0.0.1' http://172.20.0.1:5191/) || exit 1
[ "$code" = 200 ] || { echo "demo backend answered $code through the proxy"; exit 1; }
echo ok
