# The host lab: a small Debian server with three planting decisions a real box
# makes and a black-box tester must find.
#
# Planted, in severity order:
#   1. A staff onboarding note in the web root names the account, and the web root
#      also serves the password list that account is in. sshd accepts it.
#        -> /home/webdev/user.txt
#   2. /usr/local/bin/fetch is SUID root and cats any path it is given.
#        -> /root/root.txt (a shell as webdev reads it at once)
#   3. /usr/local/bin/jobs/backup.sh is world-writable and a root loop runs it
#      every few seconds. An appended line runs as root.
#        -> /root/cron.txt
#
# Two root-only files, not one: a tester that finds both routes has found two
# root causes, and the oracle can tell them apart by which file came back.
#
# The lab needs the default capability set and must not run with
# no-new-privileges: that flag blocks setuid from gaining root at exec.
FROM --platform=linux/amd64 debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server python3 procps file coreutils grep sed gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*

# ---- 1. the account, the note, the password list -------------------------
RUN useradd -m -s /bin/bash webdev \
    && printf 'webdev:Summer2026!\n' | chpasswd

RUN mkdir -p /var/www/html /run/sshd /lab \
    && cat > /var/www/html/notes.txt <<'NOTE'
onboarding, week 1

webdev - front end. ssh from the office only.
ops still has not moved us off the shared password list.
NOTE

# 60 candidates, the real one at line 41. A human scrolling this finds nothing;
# a wordlist run finds it in seconds.
RUN : > /var/www/html/passwords.txt \
    && for w in spring summer autumn winter Autumn Winter Summer Spring; do \
         for y in 2025 2026; do printf '%s%s\n' "$w" "$y" >> /var/www/html/passwords.txt; done; done \
    && for w in Spring Summer Autumn Winter; do \
         for y in 2024 2025 2026; do printf '%s%s!\n' "$w" "$y" >> /var/www/html/passwords.txt; done; done \
    && printf 'Summer2026!\n' >> /var/www/html/passwords.txt \
    && printf 'ChangeMe123\nPassword1\nadmin\nletmein\n' >> /var/www/html/passwords.txt

# ---- 2. the SUID reader ---------------------------------------------------
# A compiled binary, not a script: Linux ignores the setuid bit on scripts.
COPY fetch.c /lab/fetch.c
RUN gcc -O0 -o /usr/local/bin/fetch /lab/fetch.c \
    && strip /usr/local/bin/fetch \
    && chown root:root /usr/local/bin/fetch && chmod 4755 /usr/local/bin/fetch

# ---- 3. the world-writable job a root loop runs ---------------------------
RUN mkdir -p /usr/local/bin/jobs /var/backups \
    && printf '#!/bin/sh\n# nightly config backup (ops)\ncp /etc/passwd /var/backups/passwd.bak\n' > /usr/local/bin/jobs/backup.sh \
    && chmod 0777 /usr/local/bin/jobs/backup.sh

# ---- entrypoint -----------------------------------------------------------
COPY entrypoint.sh /lab/entrypoint.sh
RUN chmod 0755 /lab/entrypoint.sh

EXPOSE 22 80
ENTRYPOINT ["/lab/entrypoint.sh"]
