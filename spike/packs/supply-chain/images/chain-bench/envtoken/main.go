// chain-bench, with the GitHub token read from the environment (Touchstone).
//
// Upstream chain-bench v0.1.10 takes the token only as the flag -t /
// --access-token. A flag is in the process's argv, and argv is public: the
// host `ps` (and /proc/<pid>/cmdline) shows a container's processes to every
// local user. So a wrapper that runs `chain-bench -t "$TOKEN"`, even inside the
// container, would still leak it.
//
// This main is built into the chain-bench module next to upstream's own
// cmd/chain-bench/main.go (it is the same program; only how the token arrives
// differs). It reads the token from SCM_TOKEN and appends the flag to os.Args
// before cobra parses it. os.Args is this program's own copy: changing it never
// changes the process's argv in /proc, so the token is in no command line,
// inside the container or on the host. A token given on the command line, in any
// form the flag parser accepts, is refused, so it cannot be put back there by
// mistake. os.Unsetenv only removes it from this program's own environment (and
// so from any child): /proc/<pid>/environ still shows the environment the
// process started with, to the same user and root, while it lives.
package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/aquasecurity/chain-bench/internal/commands"
)

var version = "v0.1.10"

// tokenFlag reports whether one argument sets the access token, in any form the
// flag parser (pflag) accepts: --access-token, --access-token=V, and a short
// cluster that reaches t: -t, -tV, -t=V, -qtV. In a cluster, a boolean short
// flag (q quiet, v verbose, h help) lets the next letter be another flag; any
// other letter takes the rest as its value, so -o/tmp/t.json is not the token.
func tokenFlag(a string) bool {
	if a == "--access-token" || strings.HasPrefix(a, "--access-token=") {
		return true
	}
	if len(a) < 2 || a[0] != '-' || a[1] == '-' {
		return false
	}
	for _, c := range a[1:] {
		if c == 't' {
			return true
		}
		if !strings.ContainsRune("qvh", c) {
			return false
		}
	}
	return false
}

func main() {
	for _, a := range os.Args[1:] {
		if a == "--" {
			break // the rest are not flags
		}
		if tokenFlag(a) {
			fmt.Fprintln(os.Stderr, "chain-bench (touchstone): the token is read from SCM_TOKEN only; a token flag on the command line is refused")
			os.Exit(2)
		}
	}
	token := os.Getenv("SCM_TOKEN")
	if token == "" {
		fmt.Fprintln(os.Stderr, "chain-bench (touchstone): SCM_TOKEN is not set")
		os.Exit(2)
	}
	os.Unsetenv("SCM_TOKEN")
	os.Args = append(os.Args, "--access-token", token)
	if err := commands.Execute(version); err != nil {
		os.Exit(1)
	}
}
