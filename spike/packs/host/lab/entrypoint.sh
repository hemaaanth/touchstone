#!/bin/sh
# Start the lab. The flag arrives from the engine (TOUCHSTONE_FLAG) and is
# planted in the two root-only files before anything is reachable, so the two
# root routes are the only way to it.
set -e

FLAG="${TOUCHSTONE_FLAG:?TOUCHSTONE_FLAG is required}"

printf '%s\n' "$FLAG" > /home/webdev/user.txt
printf '%s\n' "${FLAG}-root" > /root/root.txt
printf '%s\n' "${FLAG}-cron" > /root/cron.txt
chown webdev:webdev /home/webdev/user.txt
chmod 600 /home/webdev/user.txt /root/root.txt /root/cron.txt

# sshd: root login by key off, password auth on for the staff account.
cat > /etc/ssh/sshd_config.d/lab.conf <<'CONF'
PasswordAuthentication yes
PermitRootLogin no
UsePAM yes
CONF
ssh-keygen -A >/dev/null 2>&1
/usr/sbin/sshd -D -e >/var/log/sshd.log 2>&1 &

# the web root: onboarding note and the password list
(cd /var/www/html && exec python3 -m http.server 80 >/var/log/httpd.log 2>&1) &

# the root loop that runs the writable job (planted bug 3)
(
  while :; do
    sh /usr/local/bin/jobs/backup.sh >/dev/null 2>&1 || true
    sleep 3
  done
) &

sleep 1
: > /lab/ready
wait
