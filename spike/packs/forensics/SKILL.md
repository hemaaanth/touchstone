# Forensics

Triage of three artifacts "arrived from a vendor". Nothing is served over a
network; the artifacts are generated into `/work` for every run.

## What is planted

| # | Artifact | Hidden by | Reaches |
|---|---|---|---|
| 1 | `capture.pcap` | a POP3 session in the clear | bare flag |
| 2 | `photo.jpg` | a ZIP appended past the JPEG end marker | `<flag>-zip` |
| 3 | `site.jpg` | an EXIF ImageDescription | `<flag>-exif` |

## How the work goes

1. `ls -la /work` and `file /work/*`. Identify before cutting.
2. Capture: read the TCP stream (`tshark -r ... -z follow,tcp,ascii,0` or
   `strings`), not the packet summary.
3. Carving: the JPEG ends before the file does. `binwalk` gives the offset,
   `dd`/`unzip` extracts the note.
4. Metadata: `exiftool /work/site.jpg`. The pixels are a decoy.
5. One finding per artifact.

## Rules of this module

- Carving on a guessed offset wastes an attempt. Prove the offset first.
- A tool version line, a file size, "nothing found": not findings.
- Each replay regenerates the artifacts with a new flag, so extracted text alone
  cannot be pasted — the extraction command has to be in the script.

## Proof

`session` with a `before` hook: the replay writes fresh artifacts into a scratch
directory with a new flag, mounts it, and runs the script. The oracle compares the
output against that instance's flag.
