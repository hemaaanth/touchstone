#include <stdio.h>
#include <string.h>

/* The licence key is compared here, and the key is only XOR-obfuscated.
   A debug line dumps the compared bytes on failure (a real leftover). */
static const unsigned char KEY_OBF[] = { KEYOBF };
static const unsigned char X = 0x5a;
static const size_t N = sizeof KEY_OBF - 1;

static void dump(void) {
  printf("expected:");
  for (size_t i = 0; i < N; i++) printf(" %02x", KEY_OBF[i]);
  printf("\n");
}

int main(void) {
  char in[128];
  printf("licence: ");
  fflush(stdout);
  if (!fgets(in, sizeof in, stdin)) return 1;
  in[strcspn(in, "\n")] = 0;
  if (strlen(in) != N) { dump(); puts("rejected"); return 1; }
  for (size_t i = 0; i < N; i++) {
    /* the array holds the key XOR X; the input is plain, so decode the array */
    if ((unsigned char)in[i] != (unsigned char)(KEY_OBF[i] ^ X)) { dump(); puts("rejected"); return 1; }
  }
  puts("granted");
  puts("@FLAG@-check");
  return 0;
}
