#include <stdio.h>

/* Nothing here prints the flag: it sits XOR-obfuscated in .rodata. */
static const unsigned char HIDDEN[] = { HIDDENBYTES };

int main(void) {
  puts("register, press any key");
  puts("the build stamp was not stripped out of .rodata");
  (void)HIDDEN;
  return 0;
}
