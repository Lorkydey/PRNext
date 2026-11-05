"""Regenerate original PRNext test fonts; maintainer-only fontTools + Brotli required.

These simple outlines and metadata are authored for PRNext and distributed under
the repository MIT license. No system or third-party font is copied.
"""
from pathlib import Path
from io import BytesIO
import struct
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.ttLib import TTCollection
from fontTools.designspaceLib import DesignSpaceDocument, AxisDescriptor, SourceDescriptor
from fontTools.varLib import build as build_variable

DESTINATION = Path(__file__).resolve().parent
GLYPHS = [".notdef", "space", "a", "b", "eacute"]
WIDTHS = {".notdef": 600, "space": 250, "a": 600, "b": 640, "eacute": 580}


def make_font(cff=False, second=False):
    builder = FontBuilder(1000, isTTF=not cff)
    builder.setupGlyphOrder(GLYPHS)
    outlines = {}
    for name in GLYPHS:
        pen = T2CharStringPen(WIDTHS[name], None) if cff else TTGlyphPen(None)
        if name != "space":
            pen.moveTo((50, 0))
            pen.lineTo((50, 700))
            pen.lineTo((WIDTHS[name] - 50, 700))
            pen.lineTo((WIDTHS[name] - 50, 0))
            pen.closePath()
        outlines[name] = pen.getCharString() if cff else pen.glyph()
    if not cff:
        builder.setupGlyf(outlines)
    builder.setupHorizontalMetrics({name: (WIDTHS[name] + (100 if second else 0), 50) for name in GLYPHS})
    builder.setupHorizontalHeader(ascent=800, descent=-200, lineGap=40)
    builder.setupCharacterMap({32: "space", 97: "a", 98: "b", 233: "eacute"})
    suffix = "Second" if second else "Regular"
    builder.setupNameTable({"familyName": "PRNext Storage Fixture", "styleName": suffix,
                            "uniqueFontIdentifier": "PRNext-Storage-Fixture-" + suffix,
                            "fullName": "PRNext Storage Fixture " + suffix,
                            "psName": "PRNextStorageFixture-" + suffix,
                            "version": "Version 1.000",
                            "copyright": "Original PRNext test fixture; MIT License."})
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, sTypoLineGap=40,
                    usWinAscent=800, usWinDescent=200)
    builder.setupPost()
    if cff:
        builder.setupCFF("PRNextStorageFixture-Regular", {}, outlines, {})
    else:
        builder.setupMaxp()
    builder.font["head"].created = builder.font["head"].modified = 3406620156
    builder.font.recalcTimestamp = False
    return builder.font


ttf = make_font()
ttf.save(DESTINATION / "fixture.ttf")
for flavor in ["woff", "woff2"]:
    ttf.flavor = flavor
    ttf.save(DESTINATION / ("fixture." + flavor))
ttf.flavor = None
make_font(cff=True).save(DESTINATION / "fixture.otf")
collection = TTCollection()
collection.fonts = [ttf, make_font(second=True)]
collection.save(DESTINATION / "fixture.ttc")

designspace = DesignSpaceDocument()
axis = AxisDescriptor()
axis.name, axis.tag = "Weight", "wght"
axis.minimum, axis.default, axis.maximum = 400, 400, 900
designspace.addAxis(axis)
for index, weight in enumerate([400, 900]):
    source = SourceDescriptor()
    source.name = "regular" if index == 0 else "heavy"
    source.familyName, source.styleName = "PRNext Storage Fixture", source.name
    source.location = {"Weight": weight}
    source.font = make_font(second=index == 1)
    source.copyInfo = source.copyLib = source.copyFeatures = index == 0
    designspace.addSource(source)
variable, _, _ = build_variable(designspace)
variable["head"].created = variable["head"].modified = 3406620156
variable.recalcTimestamp = False
variable.save(DESTINATION / "fixture-variable.ttf")

# A minimal Macintosh data-fork resource map containing one sfnt font.
stream = BytesIO()
ttf.save(stream)
data = struct.pack(">I", len(stream.getvalue())) + stream.getvalue()
data_offset, map_offset, map_length = 256, 256 + len(data), 50
header = struct.pack(">IIII", data_offset, map_offset, len(data), map_length)
resource_map = (header + bytes(8) + struct.pack(">HH", 28, 50)
                + struct.pack(">H4sHH", 0, b"sfnt", 0, 10)
                + struct.pack(">Hh", 128, -1) + bytes(8))
assert len(resource_map) == map_length
(DESTINATION / "fixture.dfont").write_bytes(header + bytes(data_offset - len(header)) + data + resource_map)
