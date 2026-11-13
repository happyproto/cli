FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --chmod=0755 happyview /opt/happyview/happyview
COPY --chmod=0755 entrypoint.sh /usr/local/bin/happyview-entrypoint
ENTRYPOINT ["/usr/local/bin/happyview-entrypoint"]
