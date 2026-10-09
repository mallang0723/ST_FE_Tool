ARG ST_IMAGE=ghcr.io/sillytavern/sillytavern:1.19.0
FROM ${ST_IMAGE}
COPY . /opt/damso-tools
RUN chmod -R a+rX /opt/damso-tools && node /opt/damso-tools/docker/prepare-image.mjs /home/node/app
ENV DAMSO_USER=default-user
ENTRYPOINT ["tini", "--", "sh", "/opt/damso-tools/docker/entrypoint.sh"]
