#!/usr/bin/env python3
"""Write the forensics artifacts for one instance into the work directory.

Three findings, each a real triage step, each hiding part of the instance flag:
  1. capture.pcap  a POP3 session in the clear            -> flag
  2. photo.jpg     a ZIP appended after the JPEG data     -> flag-zip
  3. site.jpg      the flag in an EXIF ImageDescription   -> flag-exif

Nothing needs a library: the pcap is assembled byte by byte, the ZIP by zipfile,
and the EXIF segment is written as a TIFF block in an APP1 marker.
"""
import io
import os
import struct
import sys
import time
import zipfile

FLAG = os.environ["TOUCHSTONE_FLAG"]
OUT = sys.argv[1] if len(sys.argv) > 1 else "/work"


def pcap(payloads):
    """A minimal, valid libpcap file: one TCP packet per payload."""
    def pkt(src, sport, dst, dport, data, seq):
        eth = b"\x02\x00\x00\x00\x00\x02" + b"\x02\x00\x00\x00\x00\x01" + b"\x08\x00"
        tcp = struct.pack("!HHIIHHHH", sport, dport, seq, 0, (5 << 12) | 0x18, 512, 0, 0)
        ip = struct.pack(
            "!BBHHHBBH4s4s", 0x45, 0, 20 + len(tcp) + len(data), 0, 0, 64, 6, 0,
            bytes(map(int, src.split("."))), bytes(map(int, dst.split("."))),
        )
        body = eth + ip + tcp + data
        stamp = time.time()
        return struct.pack("!IIII", int(stamp), 0, len(body), len(body)) + body

    out = struct.pack("!IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, 1)
    seq = 1
    for i, (up, port, data) in enumerate(payloads):
        client, server = ("10.20.0.9", "10.20.0.5") if up else ("10.20.0.5", "10.20.0.9")
        out += pkt(client, port if up else 110, server, 110 if up else port, data, seq)
        seq += len(data)
    return out


def main():
    os.makedirs(OUT, exist_ok=True)

    session = [
        (False, 41000, b"+OK pop3 ready\r\n"),
        (True, 41000, b"USER analyst\r\n"),
        (False, 41000, b"+OK\r\n"),
        (True, 41000, b"PASS " + FLAG.encode() + b"\r\n"),
        (False, 41000, b"+OK maildrop has 1 message\r\n"),
        (True, 41000, b"RETR 1\r\n"),
        (False, 41000, b"+OK 48 octets\r\n"),
    ]
    with open(os.path.join(OUT, "capture.pcap"), "wb") as f:
        f.write(pcap(session))

    # A real (tiny) JPEG, then a ZIP appended past its EOI marker.
    jpeg = (
        b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
        b"\xff\xdb\x00C\x00" + bytes(range(1, 65)) +
        b"\xff\xc0\x00\x0b\x08\x00\x08\x00\x08\x01\x01\x11\x00"
        b"\xff\xc9\x00\x0b\x08" + b"\x00" * 8 + b"\xff\xda\x00\x08\x01\x01\x00\x00?\x00"
        b"\x00\x00\x00\x00\x00\x00\x00\x00\xff\xd9"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        z.writestr("notes/secret.txt", FLAG + "-zip\n")
    with open(os.path.join(OUT, "photo.jpg"), "wb") as f:
        f.write(jpeg + buf.getvalue())

    # EXIF: APP1 + TIFF header + one ASCII ImageDescription (0x010e).
    textz = (FLAG + "-exif").encode()
    value = textz + b"\x00"
    ifd_offset = 8
    entries = 1
    tiff = b"MM\x00\x2a" + struct.pack("!I", ifd_offset)
    tiff += struct.pack("!H", entries)
    tiff += struct.pack("!HHI", 0x010E, 2, len(value)) + struct.pack("!I", 8 + 2 + 12 * entries + 4)
    tiff += struct.pack("!I", 0)  # no next IFD
    tiff += value
    app1 = b"Exif\x00\x00" + tiff
    with open(os.path.join(OUT, "site.jpg"), "wb") as f:
        f.write(b"\xff\xd8\xff\xe1" + struct.pack("!H", len(app1) + 2) + app1 + jpeg[2:])

    with open(os.path.join(OUT, "notes.md"), "w") as f:
        f.write(
            "case 41 - image review\n\n"
            "The drive image arrived from the vendor yesterday. Triage it:\n"
            "- capture.pcap: one mail session, port 110\n"
            "- photo.jpg: the photo the client sent\n"
            "- site.jpg: press photo of the office\n\n"
            "Report what the capture and the files give away.\n"
        )


if __name__ == "__main__":
    main()
