"""Generate app icons using only Python's standard library (no image packages)."""
import math
from pathlib import Path
import struct
import zlib


def segment_distance(x, y, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    t = max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - x1 - t * dx, y - y1 - t * dy)


def chunk(kind, data):
    return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))


for size in (192, 512):
    rows = bytearray()
    for iy in range(size):
        rows.append(0)
        for ix in range(size):
            x, y = (ix + .5) * 192 / size, (iy + .5) * 192 / size
            mic = segment_distance(x, y, 96, 56, 96, 96) <= 18
            arc = y >= 98 and abs(math.hypot(x - 96, y - 98) - 36) <= 5
            lines = any(segment_distance(x, y, *p) <= 5 for p in (
                (60, 92, 60, 98), (132, 92, 132, 98), (96, 134, 96, 156), (76, 156, 116, 156)))
            rows.extend((142, 175, 255) if mic or arc or lines else (20, 27, 45))
    header = struct.pack('!IIBBBBB', size, size, 8, 2, 0, 0, 0)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b'')
    Path(__file__).with_name('public').joinpath(f'icon-{size}.png').write_bytes(png)
