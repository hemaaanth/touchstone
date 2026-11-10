# Data for offline scanning only. Never build or deploy this target image.
FROM node:22
USER root
ADD http://example.invalid/untrusted-signer.sh /usr/local/bin/signer.sh
EXPOSE 9000
CMD ["node", "signer.js"]
