/* fetch: the ops convenience wrapper. It cats one file. It is SUID so that an
   operator can read a root-owned note without a second login. A shell script
   would not carry the bit, so this is C on purpose. */
#include <stdio.h>

int main(int argc, char **argv) {
  if (argc < 2) { puts("usage: fetch PATH"); return 2; }
  FILE *f = fopen(argv[1], "rb");
  if (!f) { perror(argv[1]); return 1; }
  char buf[4096];
  size_t n;
  while ((n = fread(buf, 1, sizeof buf, f)) > 0) fwrite(buf, 1, n, stdout);
  fclose(f);
  return 0;
}
