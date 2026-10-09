#!/bin/sh
set -eu
cd /home/node/app
mkdir -p config data plugins public/scripts/extensions/third-party
if [ ! -f config/config.yaml ]; then cp default/config.yaml config/config.yaml; fi
if [ ! -f config.yaml ]; then ln -sf ./config/config.yaml config.yaml; fi
node /opt/damso-tools/install.mjs install --container-runtime --root /home/node/app --config config/config.yaml --user "${DAMSO_USER:-default-user}"
if [ "$(id -u)" = "0" ] && [ -n "${PUID:-}" ] && [ -n "${PGID:-}" ]; then
    chown -R "$PUID:$PGID" config/.damso-install-runtime plugins/st-ko-tools "data/${DAMSO_USER:-default-user}/extensions/damso-tools"
fi
exec /home/node/app/docker-entrypoint.sh "$@"
