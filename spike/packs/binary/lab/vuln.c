#include <stdio.h>
#include <stdlib.h>

struct entry { char name[64]; int granted; };

int main(void) {
  struct entry e = {{0}, 0};
  puts("name?");
  gets(e.name);
  if (e.granted) puts("@FLAG@");
  else puts("not granted");
  return 0;
}
